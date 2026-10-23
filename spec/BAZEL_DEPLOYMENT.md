# Shared cache and Vercel setup

The Bazel build produces Vercel Build Output API v3 using the locked Vercel CLI.
Browser tests run its function handlers and static files from an isolated copy.
CI archives that same output, and the deployment job calls `vercel deploy
--prebuilt`. Vercel does not run another application build on this path.
See Vercel's [build command](https://vercel.com/docs/cli/build) and
[prebuilt deployment](https://vercel.com/docs/cli/deploy#prebuilt).

## Vercel projects and CI credentials

The `0xVentures` team owns [bobr-web](https://vercel.com/0xventures/bobr-web)
for `apps/web` and [bobr-docs](https://vercel.com/0xventures/bobr-docs) for
`apps/docs`. Both use Node 24, matching the checked-in `vercel-build.json`.
Neither project has a Git repository connection, so pushes do not trigger
independent Vercel builds. Keep deployment on the Actions path.

Bazel, CI and local development pin Node 24.21.0 through `.nvmrc` and
`.tool-versions`. Vercel selects the major version and manages its own patch
updates. To update our Node 24 release, run
`node scripts/update-node.mjs VERSION`, then `asdf install` or `nvm install`.
The script fetches official Node checksums and generates the Bazel toolchain
configuration. Commit the generated files with the updated Bazel lockfile after
running the tests. A major upgrade also needs matching Vercel project settings,
both `vercel-build.json` files and the deployment script's runtime check.

The local Vercel CLI authenticated to the intended account and created these
projects. Its credentials are separate from the Vercel connector and GitHub
Actions. Do not put tokens in chat or in this repository.

The team and both project IDs are configured as Actions variables on
`ernest-oneteam/bobr`, where CI runs. Add a deployment token as `VERCEL_TOKEN`,
then set `VERCEL_DEPLOY_ENABLED=1`. Deployment remains disabled until then.

| Setting                  | Kind     | Value                             |
| ------------------------ | -------- | --------------------------------- |
| `VERCEL_ORG_ID`          | Variable | Intended account or team ID       |
| `VERCEL_WEB_PROJECT_ID`  | Variable | Web project ID                    |
| `VERCEL_DOCS_PROJECT_ID` | Variable | Docs project ID                   |
| `VERCEL_TOKEN`           | Secret   | Deployment token for that account |
| `VERCEL_DEPLOY_ENABLED`  | Variable | `1` after the above are ready     |

Pushes to `main` build and deploy production artifacts. The `bazel` branch and
same-repository PRs build previews. Fork PRs build and test without deployment
credentials. GitHub environments are named `preview` and `production`.

The deployment script checks the artifact target and requires Linux x64 with
Node 24. Preview and production are separate Bazel configurations through
`--define=deploy_env=preview` and `--define=deploy_env=production`. A developer's
macOS artifact cannot be uploaded as a Linux production build by this script.

The current apps have no required build-time environment or remote data. Account
linkage happens after the build. If an app starts consuming environment-specific
values or fetched content, declare those inputs before allowing cache reuse.
Changing a Vercel dashboard environment variable alone does not change a Bazel
key. Runtime secrets belong in Vercel, not cached build artifacts.

## Configure the shared cache

Bóbr's selected cache is self-hosted `bazel-remote` on AWS EC2, behind Caddy for
HTTPS and separate reader/writer access. Follow the
[server setup](../infra/bazel-cache/README.md) to provision it and run acceptance.
AWS account, domain and hosted validation are still pending. The wrapper also
accepts other Bazel-compatible HTTPS or gRPC TLS caches:

| Setting                     | Kind in GitHub    | Purpose                                                                                  |
| --------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `BAZEL_REMOTE_CACHE`        | Variable          | `https://…` or `grpcs://…` endpoint                                                      |
| `BAZEL_REMOTE_READ_HEADER`  | Secret            | Complete header such as `Authorization=Bearer …`, with backend-enforced read-only access |
| `BAZEL_REMOTE_WRITE_HEADER` | Secret            | Complete header for trusted push writers                                                 |
| `BAZEL_REMOTE_PUBLIC_READ`  | Optional variable | `1` only for a deliberately public read endpoint                                         |

CI gives writer credentials to pushes. PRs receive the read credential when
GitHub makes it available; fork PRs receive no secrets. Without credentials or
explicit public-read configuration, CI uses its Actions-backed disk cache.
Read-only access must be enforced by the backend. A command-line flag alone
cannot restrict a credential held by code under test.

Locally, set `BAZEL_REMOTE_CACHE` and `BAZEL_REMOTE_HEADER` in your shell's secret
manager integration. Reads are the default. Set `BAZEL_REMOTE_UPLOAD=1` only with
a writer credential. The wrapper puts credentials in a temporary mode-0600 rc
file and removes it when Bazel exits. It does not print the token or put it in
command arguments. Direct `bazel` calls bypass this wrapper.

Compatible toolchains and inputs can share actions. macOS arm64 and Linux x64
builds have different execution platforms, so do not expect their complete Next
artifacts to share a key. See [Bazel remote caching](https://bazel.build/remote/caching).

## Finish hosted validation

Run the CI workflow after configuring the account and cache. Confirm that both
preview URLs serve the tested pages and API, then exercise consecutive commits
with an unused export, a used export and a side-effect change. Repeat from a
fresh Linux client with the disk cache disabled and inspect remote-cache hits.

The local HTTP experiment proves cache restoration between independent Bazel
clients. It does not prove the selected provider's authentication or eviction
policy. The local artifact tests do not emulate all Vercel routing, protection,
edge features or runtime settings. Production deployment and hosted smoke tests
remain pending until the deployment credential is configured and CI deploys.

An unaffected commit reuses the artifact and browser result. The deployment
script also searches for a successful deployment with the same archive, project
settings, environment versions, CLI version and branch/PR scope. It reuses that
URL when the record still exists and is ready. Production reuse requires the
current production deployment, so a rollback cannot accidentally reuse an older
record. Missing environment version metadata disables reuse. Set
`VERCEL_FORCE_DEPLOY=1` as an Actions variable to force a new deployment.

Deployment jobs serialize per app and ref and skip superseded commits before
uploading. Project metadata can conservatively cause a new deployment even when
the artifact matches. These checks have unit coverage; consecutive hosted
deployments still need verification with the Vercel deployment credential.
