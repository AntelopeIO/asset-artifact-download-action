import axios from 'axios';
import tar from 'tar';
import unzipper from 'unzipper';
import semver from 'semver';
import stream from 'node:stream';
import fs from 'node:fs';
import github from '@actions/github';
import core from '@actions/core';

const owner = core.getInput('owner', {required: true});
const repo = core.getInput('repo', {required: true});
const file = core.getInput('file', {required: true});
const ref = core.getInput('ref', {required: true});
const prereleases = core.getInput('prereleases');
const artifactName = core.getInput('artifact-name');
const containerPackage = core.getInput('container-package');
const token = core.getInput('token', {required: true});
const octokit = github.getOctokit(token);

async function doGitRef() {
   let target_ref = ref;
   try {
      target_ref = (await octokit.rest.repos.getBranch({owner, repo, branch: ref})).data.commit.sha;
   } catch {}

   let all_matching_artifacts = [];
   for await(const { data: artifacts } of octokit.paginate.iterator(octokit.rest.actions.listArtifactsForRepo, {owner,repo}))
      all_matching_artifacts = all_matching_artifacts.concat(artifacts.filter(a => a.workflow_run.head_sha == target_ref && a.name == artifactName));
   all_matching_artifacts.sort((a,b) => -a.updated_at.localeCompare(b.updated_at));  //newest first please

   if(all_matching_artifacts.length == 0)
      throw new Error(`Failed to find artifact ${artifactName} with a ref ${target_ref}`);

   const zipResp = await axios.get(all_matching_artifacts[0].archive_download_url, {responseType:"stream", headers: {"Authorization": `Bearer ${token}`}});

   let foundIt = false;

   await stream.promises.pipeline(zipResp.data, unzipper.Parse().on('entry', entry => {
      if(entry.path.match(file)) {
         entry.pipe(fs.createWriteStream(entry.path));
         core.info(`Downloaded ${entry.path} from ${target_ref} artifact ${artifactName}`);
         foundIt = true;
      }
      else
         entry.autodrain();
   }));

   if(!foundIt)
      throw new Error("Failed to find file in artifact zipfile");
}

async function doRelease(release) {
   for(const asset of release.assets) {
      if(asset.name.match(file)) {
         const resp = await axios.get(asset.browser_download_url, {responseType:"stream"});
         await stream.promises.pipeline(resp.data, fs.createWriteStream(asset.name));
         core.info(`Downloaded ${asset.name} from release ${release.tag_name}`);
         return;
      }
   }
   
   if(!containerPackage)
      throw new Error(`No matching file found in resolved relrease ${release.tag_name}`);

   let foundIt = false;
   
   const resp = await axios.get(`https://ghcr.io/token?service=registry.docker.io&scope=repository:${owner}/${containerPackage}:pull`);
   const manifestResp = await axios.get(`https://ghcr.io/v2/${owner}/${containerPackage}/manifests/${release.tag_name}`, {headers: {"Authorization": `Bearer ${resp.data.token}`}});
   const blobResp = await axios.get(`https://ghcr.io/v2/${owner}/${containerPackage}/blobs/${manifestResp.data.layers[0].digest}`, {responseType:"stream", headers: {"Authorization": `Bearer ${resp.data.token}`}});
   const tarObj = new tar.Parse;
   tarObj.on("entry", entry => {
      if(entry.path.match(file)) {
         entry.pipe(fs.createWriteStream(entry.path));
         entry.on("end", () => {
            core.info(`Downloaded ${entry.path} from release ${release.tag_name} via ${containerPackage}`);
            foundIt = true;
            tarObj.abort();
         });
      }
      else
         entry.resume();
   });
   try {
      await stream.promises.pipeline(blobResp.data, tarObj);
   }
   catch(e) {
      if(!foundIt)
         throw e;
   }
   if(!foundIt)
      throw new Error(`Failed to find matching file in assets or package for release ${release.tag_name}`);
}

let all_releases = [];

try {
   for await(const { data: releases } of octokit.paginate.iterator(octokit.rest.repos.listReleases, {owner,repo}))
      all_releases = all_releases.concat(releases);

   const target_release = all_releases.filter(r => semver.satisfies(r.tag_name, ref,{includePrerelease:prereleases})).sort( (a,b) => semver.compareBuild(b.tag_name,a.tag_name))[0];

   if(!target_release) {
      if(artifactName === '')
         throw new Error("No satisfying releases found and no artifact-name set");
      await doGitRef();
   }
   else
      await doRelease(target_release);
} catch(e) {
   core.setFailed(e.message);
}
