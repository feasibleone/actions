# Actions

This repository contains reusable GitHub Actions workflows for various CI/CD tasks,
such as setting up Node.js environments and building Docker images. These workflows
can be integrated into other repositories to streamline development and
deployment processes. The workflows are designed to be flexible and configurable
to suit different project requirements. To use these workflows, simply reference
them in your repository's GitHub Actions configuration.

These actions will evolve over time, so make sure to check back for updates and improvements.
To use the latest version of these workflows, reference the `main` branch
of this repository in the `uses` field of your workflow job definition, like so:

```yaml
jobs:
  example-job:
    uses: feasibleone/actions/.github/workflows/<name>.yaml@main
```

As the main branch may change over time, it's recommended to pin to a specific
version for production use. For this, you can reference a specific tag
or commit SHA instead of the `main` branch, for example:

```yaml
jobs:
  example-job:
    uses: feasibleone/actions/.github/workflows/<name>.yaml@v1.0.0
```

## Rush monorepo CI workflow

`rush.yaml` is the reporting-focused CI workflow for Rush monorepos (blong and its
derivatives). It runs `rush ci-test`, then delegates the whole report to a
**repo-owned hook**:

```yaml
jobs:
  build:
    permissions:
      contents: write     # commit-metrics pushes the stacked metrics branch
      pull-requests: write # ... and opens the pull request that carries it
    uses: feasibleone/actions/.github/workflows/rush.yaml@main
    with:
      ci-test-jobs: 2
    secrets:
      REPORT_TOKEN: ${{ secrets.REPORT_TOKEN }}
```

| Input                | Purpose                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `ci-test-jobs`       | Rush `--parallelism` for the test step.                                     |
| `ci-test-verbose`    | `true` streams every project's output; the default buffers and shows only failures. |
| `allure-ga-id`       | Google Analytics measurement ID for the published Allure reports; `off` removes the tag. |
| `reports-repository` | Repository hosting the published reports (`<repo>-ci` by default).           |
| `node-version`       | Node version used by every job.                                             |

Secrets: `REPORT_TOKEN` (write access to the reports repository),
`CHROMATIC_PROJECT_TOKEN`, `BLONG_MASTER_KEY`.

### The `.ci-report/` contract

Every package that runs tests writes `<pkg>/.ci-report/`: `report.json`
(machine readable: package, runner, counts, suites, per-test status, message,
stack, file, line, trace) plus `summary.md` for humans. Each runner does this
itself — `blong-dev test` for tap, `blong-dev playwright` for Playwright,
`blong-dev report vitest` for vitest.

The workflow then runs the repository's `ci-report` script
(`rush ci-report`, skipped silently when no package implements it), which:

1. aggregates every `.ci-report/` into `report-data/ci-summary.json`,
2. renders `ci-report.md` — the action run summary **and** the sticky
   pull-request comment, the same document in both places: headline totals and
   trend, one row per package carrying its test counts, coverage, deltas and a
   link to its published report, and a **Failed suites** section listing each
   failing test. The links are derived from the reports base URL plus the
   workflow slug and run number (the workflow resolves the base URL before
   rendering), so the report does not have to be assembled a second time once
   the reports are actually published,
3. writes the `metrics` snapshot artifact,
4. rebuilds `.github/metrics.json` and `.github/history.jsonl` as *base branch +
   this run* (never appending to whatever the branch already holds, so repeated
   runs of one pull request cannot accumulate data),
5. builds the failures bundle for a red run: `ci-failures/publish/` with
   `index.html` (single-file Allure report of the failing tests only, from real
   Playwright results plus synthesised ones for tap/vitest), `failures.json` (the
   machine readable index an agent can read instead of the logs), `failures.md`
   and `traces/`.

`commit-metrics` then publishes the two baseline files as a **stacked pull
request**: it pushes them to a `metrics/` branch of their own and opens a pull
request from there onto the branch under test, so merging that pull request is
what carries them to the base branch and no separate post-merge commit is needed.
The commit is made on a fresh clone of the branch tip, so it cannot race with the
run that produced it, and the stacked branch is force-pushed to exactly one commit
ahead of the head branch on every run — it rebases itself onto a branch that moved
(release-please rewrites its branch whenever `main` moves) rather than conflicting
with it, and it cannot accumulate commits. When the branch already carries the
baseline, the action skips.

Committing onto the head branch instead would make that commit its tip, and such a
commit has to carry `[skip ci]` — so the branch would show checks that never run
instead of the checks of the commit that was actually tested. Stacking avoids that
trap entirely: nothing is skipped, because the push and the pull request both use
the workflow token, whose events start no run. That token needs `contents: write`
and `pull-requests: write`, and the repository setting **Allow GitHub Actions to
create and approve pull requests** (Settings → Actions → General → Workflow
permissions): with it off the branch is still pushed and the action warns that the
pull request was refused, which the next run retries. It must not be given a PAT,
which would start runs — two generated files must not spend CI on themselves.

A caller can additionally filter the files at the trigger, which only helps when
they are a pull request's sole changes.

```yaml
on:
  pull_request:
    branches: [main]
    paths-ignore:
      - .github/metrics.json
      - .github/history.jsonl
```

### Published reports

Per-package payloads (`<pkg>/.ci-report/publish`) and the failures bundle are
published to the `gh-pages` branch of the reports repository by `deploy-report`,
under `docs/<tool>/<workflow>/<run-number>/`. The report links each package's
payload as `<base>/<package>/<workflow>/<run>/`, and the aggregate coverage and
failure reports once per run.

One run is one commit and one push: the publish job hands the whole list of reports
to `deploy-report`, which copies every one of them in a single clone of the branch
and pushes once. A job per report (the previous matrix) cloned, committed and
force-pushed the same branch once per report instead, and each of those pushes
cancels the Pages build the previous one started.

The failures bundle additionally answers on a stable alias:

- `<base>/failures/<workflow>/<run>/failures.json`
- `<base>/failures/<workflow>/latest/failures.json`

Aliases are maintained declaratively through `deploy-report`'s `aliases` input: a
tool that reported has its alias pointed at the run — a redirect page plus the run's
small JSON, never a copy of its traces and rendered page — and a tool that did not
report — `failures` on a green run, which produces no bundle — has its alias dropped
in that same commit, so a URL handed to an agent never points at a stale report.

### Retention

Three windows, because the three kinds of file age differently:

| Input          | Default | Applies to                                                       |
| -------------- | ------: | ---------------------------------------------------------------- |
| `keep-reports` |      15 | run directories, per tool/workflow (comparable across runs)      |
| `keep-heavy`   |       2 | trace archives and the rendered page, within the retained runs   |

`keep-reports` takes one number or a JSON object, so a tool may keep fewer runs than
the rest: the coverage HTML is about 20 MB of a run and fifteen of them is most of
the site, and `rush.yaml` keeps two of it. Within the retained runs, `keep-heavy`
strips the trace archives (`traces/`, 5-7 MB each) and the rendered page (1-11 MB,
report data and attachments included) from every run older than the newest two, and
leaves a stub page that links the JSON beside it. Those are the files nobody re-opens
two runs later; the JSON is what `blong-dev ci history` compares, so a stripped run
still answers for itself.

### Shared assets

Allure inlines its whole application into a single-file report — about 3.5 MB in every
page, identical across reports built by one Allure version. Those files belong outside
the run directories: `blong-dev` writes the bundle once under `_assets/allure/` with a
content-addressed name, and every page loads it through a path that reaches the site
root from `docs/<tool>/<workflow>/<run>/`. The workflow passes that directory to
`deploy-report` as `assets`, which copies it once into `docs/_assets/`, so one file
serves every report of every tool and run and a browser keeps it in cache across them.
Nothing is pruned from it: a new Allure version adds a file, and the previous one
stays as long as a retained run references it.

### Action run duration

The report is deliberately generated from JSON rather than from runner output:
tap runs with its `json` reporter saved to `.ci-report/tap.json`, so the CI log
only shows failing tests plus a summary line instead of every passing assertion
and every diagnostics dump.

## Node.js CI Workflow

This workflow sets up a Node.js environment for continuous integration (CI)
tasks. It can be reused across multiple repositories to ensure consistent
testing and building of Node.js applications. To use this workflow in your
repository, add the following file `./.github/workflows/node.yaml`:

```yaml
name: Node.js

on:
  push:
    branches: [ "main" ]
  pull_request:
    branches: [ "main" ]

permissions:
  contents: read
  issues: read
  checks: write
  pull-requests: write

jobs:
  node:
    uses: feasibleone/actions/.github/workflows/node.yaml@main
    with:
      node-version: '22.x'
```

### Integration points

This workflow looks for the following scripts in the `./package.json` file and runs
the appropriate jobs, if the script is found. All the scripts are optional.

- `ci-lint`: This should run code linting.

  Example:

  ```json
  {
    "scripts": {
        "lint": "eslint .",
        "ci-lint": "npm run lint",
    }
  }
  ```

- `ci-unit`: This should run the unit tests in CI mode. If it outputs a file named
  `./coverage/junit.xml`, the test results will be published in the PR.

  Example:

  ```json
  {
    "scripts": {
      "ci-unit": "JEST_JUNIT_OUTPUT_DIR=coverage npm run test:unit -- --ci --reporters=default --reporters=jest-junit --outputFile=./coverage/junit.xml"
    }
  }
  ```

  ![unit tests](img/ci-unit.png)

- `ci-coverage`: This should run the test coverage in CI mode. If it outputs a
  file named `coverage/report.json`, a coverage report summary will be published
  in the PR.

  Example:

  ```json
  {
    "scripts": {
      "test:unit": "jest",
      "ci-unit": "npm run test:unit -- --silent --ci --coverage --testLocationInResults --json --outputFile=coverage/report.json"
    }
  }
  ```

  ![coverage tests](img/ci-coverage.png)

- `ci-audit`: This should run a vulnerability check for the dependencies. If it
  outputs a file named `./audit/auditResults.json`, it will be included as
  a build artifact.

  Example:

  ```json
  {
    "scripts": {
      "audit:check": "audit-ci --config ./audit-ci.jsonc",
      "ci-audit": "mkdir -p audit; npm run audit:check -- --report-type summary; npm run --silent audit:check -- -o json > ./audit/auditResults.json",
    }
  }
  ```

- `ci-deprecation`: This should run a deprecation check for the dependencies.

  Example:

  ```json
  {
    "scripts": {
      "ci-deprecation": "MODE=error check-deprecations-npm"
    },
    "devDependencies": {
      "@mojaloop/ml-depcheck-utility": "^1.1.3",
    }
  }
  ```

## Docker Workflow

This workflow builds and pushes Docker images to a container registry.
It can be reused across multiple repositories to ensure consistent Docker
image building and deployment.

To use this workflow in your repository, add the following file `./.github/workflows/docker.yaml`.

This workflow allows building multiple images from a single repository.
Use the `matrix` property to list the Dockerfiles and images, as in the
example below:

```yaml
name: Docker

on:
  push:
    tags: ["v*.*.*"]
  pull_request:
    branches: [ "main" ]

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - dockerfile: Dockerfile
            image: core-connector-template
            context: .
          - dockerfile: cbs-mock/Dockerfile
            image: cbs-mock-template
            context: ./cbs-mock
    uses: feasibleone/actions/.github/workflows/docker.yaml@main
    with:
      dockerfile: ${{ matrix.dockerfile }}
      image: ${{ matrix.image }}
      context: ${{ matrix.context }}
      owner: ${{ github.repository_owner }}
    secrets:
      REGISTRY_PASSWORD: ${{ secrets.GITHUB_TOKEN }}
```

### Pushing to Different Registries

By default, the workflow will build and push images to the GitHub Container Registry.
To push to Docker Hub or another registry, pass the `registry`, `owner` and
`REGISTRY_PASSWORD` like this:

```yaml
jobs:
  build:
    uses: feasibleone/actions/.github/workflows/docker.yaml@main
    with:
      registry: docker.io
      owner: example-owner
    secrets:
      REGISTRY_PASSWORD: ${{ secrets.DOCKERHUB_PASSWORD }}
```

### Triggering downstream workflows

To trigger downstream workflows after a successful Docker image build and push,
set the `downstream` and `TRIGGER_DOWNSTREAM` secret like this:

```yaml
jobs:
  build:
    uses: feasibleone/actions/.github/workflows/docker.yaml@main
    with:
      downstream: https://api.github.com/repos/<owner>/<repo>/actions/workflows/<workflow_name>.yaml/dispatches
    secrets:
      TRIGGER_DOWNSTREAM: ${{ secrets.TRIGGER_TOKEN }}
```

## Release

This workflow automates the release process using the
[Release Please tool](https://github.com/googleapis/release-please).

This tool does the following:

- Analyzes merged pull requests to determine the next semantic version bump
  (major, minor, patch) based on conventional commit messages.
- Updates the version in relevant files (e.g., `package.json`, `CHANGELOG.md`).
- Creates a new release pull request with the updated version and changelog.
  When the release PR is merged, it automatically creates a new GitHub release,
  which can trigger the Docker workflow to build and push new images.

Check the [Release Please documentation](https://github.com/googleapis/release-please)
for more details.

It can be reused across multiple repositories to ensure consistent versioning
and changelog generation. To use this workflow in your repository, add the
following file `./.github/workflows/release.yml`:

```yaml
name: Release
on:
  push:
    branches:
      - main

jobs:
  release:
    uses: feasibleone/actions/.github/workflows/release.yaml@main
    secrets:
      token: ${{ secrets.RELEASE_PLEASE_TOKEN }}
```

### Configuring the RELEASE_PLEASE_TOKEN

To allow the Release Please workflow to create release pull requests and
GitHub releases, you need to provide a personal access token (PAT) with the
`repo` scope. Create a new PAT in your GitHub account settings and add it
as a secret named `RELEASE_PLEASE_TOKEN` in your repository settings.

1. Navigate to https://github.com/settings/personal-access-tokens/new
1. Fill the fields as needed and ensure the following permissions are selected:

   - Contents: Read & Write
   - Pull requests: Read & Write
   ![personal access tokenpermissions](img/pat-permissions.png)
1. Click "Generate token" and copy the generated token.
1. Go to your repository on GitHub, navigate to "Settings" > "Secrets and
   variables" > "Actions".
1. Click "New repository secret", name it `RELEASE_PLEASE_TOKEN`, and paste the
   copied token into the "Value" field.
![new action secret](img/new-action-secret.png)
1. Click "Add secret" to save.
