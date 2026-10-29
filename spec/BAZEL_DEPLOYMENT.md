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

CI runs on `IShotTheSheriff/bobr`. Set the values below there. Create the token
in the Vercel team settings and store it only as a GitHub secret.
Deployment remains disabled until `VERCEL_DEPLOY_ENABLED=1`.

Store these settings on the repository, or on the GitHub environments the
deploy job uses: `preview` for branches and PRs, `production` for `main`.
Environment settings take precedence and let `production` require `main` or a
reviewer. With per-environment settings, add them to both environments; each
deploy job reports in the run summary which settings its environment is missing.

```sh
gh variable set VERCEL_ORG_ID --repo IShotTheSheriff/bobr --body team_741BpS6ntDg8vt3g4Mb4VW3d
gh variable set VERCEL_WEB_PROJECT_ID --repo IShotTheSheriff/bobr --body prj_k3tVj5hvQzFRwqH0ZKaVeAbNkLT5
gh variable set VERCEL_DOCS_PROJECT_ID --repo IShotTheSheriff/bobr --body prj_huSklU0QuBfsObtmU9zKxWhuAB93
gh secret set VERCEL_TOKEN --repo IShotTheSheriff/bobr   # paste the token at the prompt
gh variable set VERCEL_DEPLOY_ENABLED --repo IShotTheSheriff/bobr --body 1
```

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

Both projects use Vercel Authentication for every deployment URL except custom
domains. People outside the Vercel team, and scripts without a bypass secret,
get a login page instead of the app. Locally, `vercel curl` sends authenticated
requests to a protected deployment.

After each deploy or reuse, CI compares the live URL with the archive the
browser tests passed. `tools/bazel/check-deployment.cjs` serves that archive
locally and requests `/`, `/demo`, `/api/hello`, a missing page and the home
page's static assets from both. Status codes, page titles and API bodies must
match, and every asset must load. To let CI through Vercel Authentication,
create a "Protection Bypass for Automation" secret in each project and store
them as `VERCEL_WEB_BYPASS_SECRET` and `VERCEL_DOCS_BYPASS_SECRET` repository
secrets. Without them, the check reports that it skipped.

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

Bóbr shares Bazel results through the team's Vercel Remote Cache, the store
Turborepo uses. Bazel cannot talk to it directly, so `scripts/bazel.py` starts
`tools/bazel/vercel-cache.cjs`, a localhost proxy that translates Bazel's HTTP
cache protocol into Vercel's `/v8/artifacts` API. Developers run `vercel login`
once; the wrapper finds that login, or `VERCEL_TOKEN`, and uses the cache. Set
`BAZEL_REMOTE_CACHE=off` to build without it.

The team is on Vercel's Hobby plan, which allows 100 cache requests a minute and
10 GB of downloads a month. The wrapper therefore caches only Next builds and
test results remotely; every other step reruns locally in seconds. A Next build
stores one archive, so a fully cached build needs about 60 requests. Vercel
expires artifacts after 7 days.

Vercel tokens cannot be limited to reading, so CI and developers write separate
namespaces. CI signs the action results it writes with `BAZEL_CACHE_SIGNING_KEY`
and ignores unsigned ones. Bazel verifies every downloaded file against its
digest. A developer's upload therefore never reaches a CI build. Developers read
CI's results first, then their teammates'. Linux machines reuse CI's builds;
macOS machines share with each other, because Bazel keys include the platform's
Node binary.

Set these on `IShotTheSheriff/bobr` for the build job. They must be repository
settings, because the build job uses no environment. In the web UI they are
under Settings > Secrets and variables > Actions. With `gh` logged in as a
repository admin:

```sh
gh secret set VERCEL_TOKEN --repo IShotTheSheriff/bobr     # the same team token
openssl rand -base64 32 | gh secret set BAZEL_CACHE_SIGNING_KEY --repo IShotTheSheriff/bobr
gh variable set BAZEL_REMOTE_CACHE --repo IShotTheSheriff/bobr --body vercel
```

Trusted pushes upload; pull requests only read. Fork PRs receive no secrets and
use the Actions cache alone.

The wrapper also accepts any Bazel-compatible HTTPS or gRPC TLS cache, such as
the [self-hosted server](../infra/bazel-cache/README.md) with separate reader
and writer credentials:

| Setting                     | Kind in GitHub    | Purpose                                                                                  |
| --------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `BAZEL_REMOTE_CACHE`        | Variable          | `https://…` or `grpcs://…` endpoint                                                      |
| `BAZEL_REMOTE_READ_HEADER`  | Secret            | Complete header such as `Authorization=Bearer …`, with backend-enforced read-only access |
| `BAZEL_REMOTE_WRITE_HEADER` | Secret            | Complete header for trusted push writers                                                 |
| `BAZEL_REMOTE_PUBLIC_READ`  | Optional variable | `1` only for a deliberately public read endpoint                                         |

The wrapper puts credentials in a temporary mode-0600 rc file or the proxy's
environment and removes them when Bazel exits. It does not print tokens or put
them in command arguments. Direct `bazel` calls bypass this wrapper.

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
edge features or runtime settings. Preview deployment and reuse passed on
Vercel on 2026-10-26; production deploys start when the branch reaches `main`.
Vercel makes a project's first deployment production unless the request names
a target, so preview deploys pass `--target preview`.

An unaffected commit reuses the artifact and browser result. The deployment
script also searches for a successful deployment with the same archive, project
settings, environment versions, CLI version and branch/PR scope. It reuses that
URL when the record still exists and is ready. Production reuse requires the
current production deployment, so a rollback cannot accidentally reuse an older
record. Missing environment version metadata disables reuse. Set
`VERCEL_FORCE_DEPLOY=1` as an Actions variable to force a new deployment.

After an [Instant Rollback](https://vercel.com/docs/deployments/instant-rollback),
Vercel keeps production on the rolled-back deployment until someone promotes a
newer one. CI then still deploys each tested archive to production, warns that
production serves another deployment, and prints the `vercel promote` command.
It never promotes on its own, so a rollback during an incident stays in place.

Deployment jobs serialize per app and ref and skip superseded commits before
uploading. Project metadata can conservatively cause a new deployment even when
the artifact matches. These checks have unit coverage; consecutive hosted
deployments still need verification with the Vercel deployment credential.
