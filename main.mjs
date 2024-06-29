import axios from 'axios';
import * as tar from 'tar';
import unzipper from 'unzipper';
import semver from 'semver';
import stream from 'node:stream';
import fs from 'node:fs';
import github from '@actions/github';
import core from '@actions/core';
import * as child_process from 'node:child_process';
import { pipeline } from 'node:stream/promises';

if (process.argv[2] === 'child') {
   const msg = await new Promise((resolve) => {
      process.on('message', (m) => resolve(m));
   });
   const resp = await axios.get(msg.url, {responseType:"stream", headers: {"Range": "bytes="+msg.offset+"-"+msg.end,"Authorization": `Bearer ${msg.token}`}});
   await pipeline(resp.data, process.stdout);
   process.exit(0);
}

const owner = core.getInput('owner', {required: true});
const repo = core.getInput('repo', {required: true});
const file = core.getInput('file', {required: true});
const target = core.getInput('target', {required: true});
const prereleases = core.getBooleanInput('prereleases');
const artifactName = core.getInput('artifact-name');
const containerPackage = core.getInput('container-package');
const token = core.getInput('token', {required: true});
const failOnMissingTarget = core.getBooleanInput('fail-on-missing-target', {required: true});
const waitForExactTarget = core.getBooleanInput('wait-for-exact-target', {required: true});
const octokit = github.getOctokit(token);

core.setOutput('downloaded-file', '');

class NothingFoundError extends Error {
   constructor(message) {
     super(message);
     this.name = 'NothingFoundError';
   }
}

//returns workflow runs at a ref sorted by run attempt, with currently running workflow filtered out; throws if no workflows found
async function getLatestWorkflowRuns(ref) {
   let all_workflow_runs_at_ref = [];
   for await(const { data: runs } of octokit.paginate.iterator(octokit.rest.actions.listWorkflowRunsForRepo, {owner,repo,head_sha:ref}))
      all_workflow_runs_at_ref = all_workflow_runs_at_ref.concat(runs);
   all_workflow_runs_at_ref.sort((a, b) => b.run_attempt - a.run_attempt);

   //filter ourselves out
   all_workflow_runs_at_ref = all_workflow_runs_at_ref.filter(a => a.id != Number(process.env.GITHUB_RUN_ID));

   if(all_workflow_runs_at_ref.length == 0)
      throw new Error(`No workflows found for ${ref}`);

   return all_workflow_runs_at_ref;
}

async function doGitRef(target_ref) {
   let all_workflow_runs_at_ref = await getLatestWorkflowRuns(target_ref);

   if(all_workflow_runs_at_ref.filter(r => r.status != 'completed').length) {
      if(waitForExactTarget) {
         while(all_workflow_runs_at_ref.filter(r => r.status != 'completed').length) {
            console.log(`Waiting for workflows at ${target_ref} to complete...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            all_workflow_runs_at_ref = await getLatestWorkflowRuns(target_ref);
         }
      }
      else {
         const { data: commit } = await octokit.rest.repos.getCommit({owner, repo, ref:target_ref});
         if(commit.parents.length == 0)
            throw new Error(`No parent commit for ${target_ref}`);
         console.log(`Workflows not complete on ${target_ref}, trying parent...`);
         return doGitRef(commit.parents[0].sha);
     }
   }

   let all_matching_artifacts = [];
   for await (const run of all_workflow_runs_at_ref)
      for await(const { data: artifacts } of octokit.paginate.iterator(octokit.rest.actions.listWorkflowRunArtifacts, {owner,repo,run_id:run.id}))
         all_matching_artifacts = all_matching_artifacts.concat(artifacts.filter(a => a.name == artifactName));

   if(all_matching_artifacts.length == 0)
      throw new NothingFoundError(`Failed to find artifact ${artifactName} with a ref ${target_ref}`);

   const customUnzipperSource = {
      stream: function(offset, length) {
         const end = length ? offset + length : '';

         let childp = child_process.fork(import.meta.filename, ['child'], {stdio: ["pipe", "pipe", "inherit", "ipc"]});
         childp.send({
            url: all_matching_artifacts[0].archive_download_url,
            offset: offset,
            end: end,
            token: token
         });
         return childp.stdout;
      },
      size: async function() {
         return((await axios.head(all_matching_artifacts[0].archive_download_url, { headers: {"Authorization": `Bearer ${token}`}}))).headers['content-length']
      }
    };

   const directory = await unzipper.Open.custom(customUnzipperSource);

   let foundIt = false;

   for(const entry of directory.files) {
      if(entry.path.match(file)) {
         await pipeline(entry.stream(), fs.createWriteStream(entry.path));
         core.info(`Downloaded ${entry.path} from ${target_ref} artifact ${artifactName}`);
         core.setOutput('downloaded-file', entry.path);
         foundIt = true;
      }
   }

   if(!foundIt)
      throw new Error("Failed to find file in artifact zipfile");
}

async function doRelease(release) {
   for(const asset of release.assets) {
      if(asset.name.match(file)) {
         const resp = await axios.get(asset.browser_download_url, {responseType:"stream"});
         await stream.promises.pipeline(resp.data, fs.createWriteStream(asset.name));
         core.info(`Downloaded ${asset.name} from release ${release.tag_name}`);
         core.setOutput('downloaded-file', asset.name);
         return;
      }
   }
   
   if(!containerPackage)
      throw new Error(`No matching file found in resolved relrease ${release.tag_name}`);

   let foundIt = false;
   
   const resp = await axios.get(`https://ghcr.io/token?service=registry.docker.io&scope=repository:${owner}/${containerPackage}:pull`);
   const manifestResp = await axios.get(`https://ghcr.io/v2/${owner}/${containerPackage}/manifests/${release.tag_name}`, {headers: {"Authorization": `Bearer ${resp.data.token}`}});
   const blobResp = await axios.get(`https://ghcr.io/v2/${owner}/${containerPackage}/blobs/${manifestResp.data.layers[0].digest}`, {responseType:"stream", headers: {"Authorization": `Bearer ${resp.data.token}`}});
   const tarObj = new tar.Parser;
   tarObj.on("entry", entry => {
      if(entry.path.match(file)) {
         entry.pipe(fs.createWriteStream(entry.path));
         entry.on("end", () => {
            core.info(`Downloaded ${entry.path} from release ${release.tag_name} via ${containerPackage}`);
            core.setOutput('downloaded-file', entry.path);
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

   const target_release = all_releases.filter(r => semver.satisfies(r.tag_name, target, {includePrerelease:prereleases})).sort( (a,b) => semver.compareBuild(b.tag_name,a.tag_name))[0];

   if(!target_release) {
      if(artifactName === '')
         throw new NothingFoundError("No satisfying releases found and no artifact-name set");
      let target_ref = target;
      try {
         target_ref = (await octokit.rest.repos.getBranch({owner, repo, branch: target})).data.commit.sha;
      } catch {}
      await doGitRef(target_ref);
   }
   else
      await doRelease(target_release);
} catch(e) {
   if(e instanceof NothingFoundError) {
      if(failOnMissingTarget)
         core.setFailed(e.message);
   }
   else {
      core.setFailed(e.message);
   }
}
