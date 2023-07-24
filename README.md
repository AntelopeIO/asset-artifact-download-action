## Download A Release Asset, Build Artifact, Or File In Container Package

This action will download a release asset, a build artifact, or a file within a container package based on its inputs and what it discovers while following a set of rules useful to AntelopeIO projects.

### Changelog
* **v3**: added `fail-on-missing-target`; added `downloaded-file` output; made `token` optional; reduces API usage substantially
* **v2**: renamed `ref` to `target`; fixes `prereleases` behavior

### Inputs
**`owner`**, **`repo`**, and **`token`** should be self explanatory and are all required.

**`file`** is a required _regular expression_ of which the first file matching it will be downloaded to the current working directory.

**`target`** is required and can be either a [semver range](https://github.com/npm/node-semver), a branch name, or commit hash. The action then follows a series of steps to search for a file matching the `file` regular expression.

* Along with using the optional boolean input **`prereleases`**, the action treats `target` as a semver range and finds the maximum satisfying release given the semver range. If a release is found, then:
  * Find a release asset matching the `file` regular expression and save it to the current directory. Action is complete if a file was found.
  * If **`container-package`** is provided, extract to the current directory the first file matching the `file` regular expression contained in the first layer of the package at `ghcr.io/owner/container-package:release`. Action is complete if a file was found.
  * Actions fails if neither of the two steps above succeeded.
* If no releases satisfy the semver range (possibly because it wasn't a valid semver range to begin with), then if **`artifact-name`** is provided:
  * Attempt to find a branch named `target`, and discover its HEAD commit that will be used for the next step. If no branch is found, `target` is then treated as a commit hash and used for the next step.
  * Find the most recently created (by wallclock time) workflow artifact named `artifact-name` from a workflow run matching the commit hash discovered in the previous step. Extract the first file matching the `file` regular expression from the artifact "bucket" to the current directory. Action is complete if a file was found.
  * Action fails if the previous step fails to find a file.

**`fail-on-missing-target`** is an optional boolean (defaulted to _true_) to control whether the action should fail if the `file` is not found in the case of `target` being a release, or if `artifact-name` is not found in the case of `target` being a branch or ref (which includes the situation where the branch or ref does not exist). Other failures, for example, the `file` not being found in the `artifact-name`, are still considered failures even if this is set to false.

### Outputs

**`downloaded-file`** is the filename of the downloaded file, or an empty string if an error occurred.

### Examples
This will download the latest released cdt debian binary for x86_64, inclusive of prereleases (such as v3.0.0-rc2)
```yaml
    - name: Download Latest cdt
        uses: AntelopeIO/asset-artifact-download-action@v3
        with:
          owner: AntelopeIO
          repo: cdt
          file: 'cdt_.*amd64.deb'
          target: '*'
          prereleases: true
```

This will download the latest non-prerelease 3.x.x leap-dev package. But since the leap-dev package is not part of the released assets, it needs to extract it from the `experimental-binaries` container image.
```yaml
    - name: Download 3.x leap dev package
        uses: AntelopeIO/asset-artifact-download-action@v3
        with:
          owner: AntelopeIO
          repo: leap
          file: 'leap-dev.*x86_64.deb'
          target: '3.x'
          container-package: experimental-binaries
```

In this case, a leap-dev is needed from the `new_host_functions` branch. The leap-dev.deb file needs to be found in the `leap-dev-ubuntu20-amd64` artifact bucket.
```yaml
    - name: Download leap dev package from branch
        uses: AntelopeIO/asset-artifact-download-action@v3
        with:
          owner: AntelopeIO
          repo: leap
          file: 'leap-dev.*x86_64.deb'
          target: new_host_functions
          artifact-name: leap-dev-ubuntu20-amd64
```

A more complex job which tries to fetch a leap-dev from a `juiceup` branch but has a fallback in case no `leap-dev-ubuntu20-amd64` artifact is found.
```yaml
      - id: getit
        uses: AntelopeIO/asset-artifact-download-action@v3
        with:
          owner: AntelopeIO
          repo: leap
          file: 'leap-dev.*amd64.deb'
          target: juiceup
          artifact-name: leap-dev-ubuntu20-amd64
          fail-on-missing-target: false
      - if: steps.getit.outputs.downloaded-file != ''
        run: echo downloaded ${{steps.getit.outputs.downloaded-file}}
      - if: steps.getit.outputs.downloaded-file == ''
        run: echo I need to do something else...
```

### Rebuilding `dist`
```
ncc build main.mjs --license licenses.txt
```
