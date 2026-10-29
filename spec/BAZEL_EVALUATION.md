# Bazel goal evaluation

Updated on 2026-10-23, after the Bazel work merged into `IShotTheSheriff/bobr`.
The acceptance criteria are unchanged: unused exports must leave intermediate
inputs unchanged, used exports and effects must invalidate correctly, developers
should not maintain hashes or build rules, consecutive PR commits should reuse
work, and Vercel should deploy the tested artifact.

## Current implementation

| Goal                                 | Implementation and evidence boundary                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skip Next for unused utility exports | The mutation experiment checks actual Next actions and unchanged projection bytes for barrel and same-module exports.                                                                                                 |
| Invalidate used exports and effects  | The experiment covers `add`, `sub`, unused barrel branches with effects and relative side-effect imports.                                                                                                             |
| Ignore unreachable UI components     | Traversal starts at app imports. Unreachable files and their utility imports do not enter Next inputs. Reachable React modules remain whole files with one runtime export each.                                       |
| Reuse nondeterministic Next output   | Bazel reuses the stored action output when projected inputs match. It never compares two independently rebuilt Next outputs to decide reuse.                                                                          |
| Share build results                  | Normal package commands and CI use the shared-cache wrapper. Fresh clients restore Next and browser actions through the actual Caddy/bazel-remote stack with disk caching disabled. AWS provisioning remains pending. |
| Preserve browser coverage            | Two Bazel targets test the deployment archive, covering hydration, interaction, navigation, API and 404 behavior.                                                                                                     |
| Deploy the tested artifact           | Bazel creates the Vercel archive; CI tests, uploads and deploys it with `--prebuilt`. Previews from the `bazel` branch deployed to both Vercel projects on 2026-10-26.                                                |
| Avoid duplicate deployments          | Reuse checks match archive bytes, settings, environment versions and branch scope against a ready deployment. Hosted runs reused unchanged apps and created a deployment only for the app whose archive changed.      |
| Avoid manual hashes                  | Bazel owns action keys. The browser pin updater generates download hashes. Evidence hashes are assertions, not build inputs maintained by developers.                                                                 |
| Avoid build-rule edits               | `next_app()` and `shared_package()` take inputs from each package's files and npm links from `pnpm-lock.yaml`. New pages, folders, utilities, tests and npm dependencies need no BUILD change.                        |
| Cache every check                    | Type checks, lint and unit tests are Bazel tests. App type checks read declarations for the UI exports they name. Unit tests read an esbuild bundle of the code they reach.                                           |

The code addresses the four open implementation areas. Preview deployment and
reuse are verified on Vercel; see [Hosted deployment](#hosted-deployment).
Production deployment starts on `main`, and the hosted cache waits for the AWS
host.

## Verification on 2026-10-23

Merging the Bazel PR left `main` red. The last branch commit had run
`bun install`, which rewrote `vercel` to `^61.0.0` and added `bun.lock`, while
`pnpm-lock.yaml` still recorded `61.0.0`. CI's frozen install failed before any
type check ran, and the deploy job never started. The fix restores the exact pin
and removes the second lockfile.

Developer edits then exposed three gaps:

- Adding `packages/ui/src/utils/mul/index.ts` to the barrel failed both app
  builds with `Could not resolve "./mul"`. The per-module Bazel packages under
  `src/utils` hid the new file from `@repo/ui`'s package glob, so a developer
  needed two BUILD edits and a Gazelle run. Those packages, Gazelle and the
  hand-written `apps/*/bazel/logic.ts` mirrors are gone.
- Next's npm inputs were a hand-kept list, and app code outside `app/` failed
  the projection. Both now come from the package itself.
- Every test's runfiles carried a repo mapping file that listed all 692 npm
  repositories. Any lockfile edit changed it and reran every test, including
  the other app's browser tests. `--incompatible_compact_repo_mapping_manifest`
  lists the npm extension once.

Type checks ran outside Bazel on every push, and CI never ran ESLint, which was
failing in both apps. Both now run as cached Bazel tests.

A scenario run applied one edit at a time to a warm cache and recorded executed
actions from Bazel's execution log. The README lists the full table. A body
change to `sub` reran only docs' build, browser test and unit test. A signature
change to `sub` also reran docs' type check and nothing in web. A new npm
dependency in docs reran only docs. README, comment-only and unreachable
component edits reran no app work. The macOS run of
`prove-next-invalidation.py --remote --browser` passed all 14 cases on the new
graph.

GitHub Actions on `IShotTheSheriff/bobr` confirmed the same behavior on fresh
Linux runners:

| Commit                                          | What ran                                                   | Run                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| New build graph                                 | Every build and check, because every action key changed    | [39994006268](https://github.com/IShotTheSheriff/bobr/actions/runs/39994006268) |
| Documentation and workflow edits                | Nothing; 15 targets reused, no cache upload                | [39994616704](https://github.com/IShotTheSheriff/bobr/actions/runs/39994616704) |
| Body of `sub` only                              | Docs build, docs browser and unit tests, UI package checks | [39996498057](https://github.com/IShotTheSheriff/bobr/actions/runs/39996498057) |
| Revert of that change                           | Nothing; 15 targets reused, no cache upload                | [39997122124](https://github.com/IShotTheSheriff/bobr/actions/runs/39997122124) |
| Full invalidation proof with HTTP cache clients | 14 of 14 cases passed                                      | [39994990364](https://github.com/IShotTheSheriff/bobr/actions/runs/39994990364) |
| Nx script removal, new BUILD-file check         | Only `//:build_files_test`; 14 targets reused              | [40480853937](https://github.com/IShotTheSheriff/bobr/actions/runs/40480853937) |
| Workflow YAML fix                               | Nothing; 18 targets reused                                 | [40890601484](https://github.com/IShotTheSheriff/bobr/actions/runs/40890601484) |
| Cache proxy notice fix                          | Only `//tools/bazel:vercel_cache_test`; 17 targets reused  | [40891010787](https://github.com/IShotTheSheriff/bobr/actions/runs/40891010787) |
| Docs test edit with Vercel cache on             | Docs unit test, type check and lint; 25 Vercel uploads     | [40899648722](https://github.com/IShotTheSheriff/bobr/actions/runs/40899648722) |
| Workflow edit with Vercel cache on              | Nothing; 18 targets reused, no Vercel requests             | [40900397539](https://github.com/IShotTheSheriff/bobr/actions/runs/40900397539) |

In the `sub` run, web's Next build, browser test, type check, lint and unit test
all came from the cache, as did docs' type check and lint.

The BUILD-file check run on 2026-10-27 also reused both production deployments,
and each passed the 9-request live check. Locally, the check failed for
`apps/admin`, `packages/admin-e2e` and `packages/charts` without BUILD files
and named the file to copy for each.

Since 2026-10-29 each CI run also posts a notice that says what ran. For the
workflow fix it read "Ran 0 of 18 Next builds and checks. 18 came from cache.
Shared Bazel cache: off." The Vercel cache proxy posts its hit, miss and upload
counts the same way. GitHub's public API returns these notices without a login,
so anyone can check a run without reading its logs.

## Why the artifact test matters

The first isolated run found missing Next runtime modules. Next imported
`node:fs/promises`, while rules_js patched `fs.promises` through a replacement
getter. Next followed the original symlink targets outside its tracing root and
omitted their dependencies. A small preload synchronizes the filesystem methods
before Vercel and Next run. This applies to Next's child processes too.

The test also exposed a packaging issue in the test setup. Bazel expands a tree
artifact's directory symlinks in runfiles. Flattening those links changes Node's
package lookup. The build now archives Vercel output before that expansion.
Tests extract the archive into an isolated directory and execute its handlers
with a clean environment. Deployment extracts the same archive. The structural
check rejects escaping symlinks, missing handlers and unmaterialized file maps.

The Linux HTTP experiment also found that the separately declared Vercel tree
changed after restoration, while both deployment archives retained identical
SHA-256 digests. The archive is now the sole declared deployment output. The
proof compares its bytes across fresh clients; browser tests and deployment
consume that exact file. The staging directory is removed after packaging.

The test adapter handles this PoC's page and API routes. It does not implement
Vercel's complete routing specification. Hosted preview smoke tests remain a
separate acceptance step.

## Cache evidence

[Run 39994616704](https://github.com/IShotTheSheriff/bobr/actions/runs/39994616704)
restored the previous commit's GitHub Actions cache and reused all 15 targets.
That shows cross-commit reuse through the Actions archive. It did not test HTTP
remote caching or Vercel artifacts.
[Shared cache through Vercel](#shared-cache-through-vercel) covers those.

The current proof creates a local HTTP action/content cache and three independent
Bazel output bases. The consumer has no producer output directory or disk-cache
entries to reuse. It reads cached Next artifacts and test results without
uploading results. Each mutation records executed Next and Playwright actions.
A third client edits an unused export before building, forcing projection to run
while Next and Playwright restore the preceding inputs' results. The evidence
includes output digests and successful cache read/write counts.

This tests the protocol and action portability between local Bazel clients. It
is not evidence that a hosted cache's credentials, permissions or eviction
policy work. Linux CI runs the same experiment; macOS and Linux have different
execution platforms and are not expected to share every Next action.

The expensive mutation experiment runs separately from ordinary CI. Its trigger
compares successive PR heads, preventing an earlier build-system change from
forcing the experiment on every later app-only commit.

The self-hosted cache acceptance test uses the deployment's pinned Caddy and
`bazel-remote` images. It checks anonymous rejection, server-enforced reader
permissions, fresh-client remote hits and reuse after an unused barrel edit.
The full macOS run passes with identical deployment archives across all three
clients. This verifies the container configuration, while AWS bootstrap, public
DNS/TLS, availability and capacity still need validation on the chosen VM.

## Remaining maintenance limits

The projection supports this repository's export map and static module layout.
It fails explicitly on patterns it cannot track, including computed imports,
`import.meta` asset lookups, `require.resolve`, utility leaf imports and shared
UI styles. Literal dynamic imports into React modules are traversed. Utilities
require static ESM and cannot contain React/server directives.

Unreachable modules are excluded. A reachable React module stays whole, so the
projection allows it one runtime export and rejects a second one with a file
name to move it to. Type exports do not count. Namespace utility imports retain
every export.
Files under `app/` and `pages/`, plus `middleware`, `proxy` and
`instrumentation` files, are conservatively roots. Other app folders count when
a root imports them, through relative paths or tsconfig `paths`. This is a useful
bounded optimizer, not a replacement for Next's own route and React compiler
analysis.

Routine edits need no rule changes. A new app still needs a copied four-line
BUILD file, an e2e package and a Vercel project. `//:build_files_test` fails
while any workspace package lacks a BUILD file. A new shared package gets its
checks from `shared_package()`, but apps consume it as a whole package until the
projection covers it. `pnpm dev` uses source files directly; `pnpm build` and
`pnpm test` populate Bazel's production build and test caches.

Build-time environment and remote content need declared inputs before they are
introduced. Preview and production already select separate action environments.
Deploy credentials and account linkage stay outside the cached build. A fixed
Next build ID reduces churn but is not a content-derived deployment identifier.

## Hosted deployment

GitHub Actions on `IShotTheSheriff/bobr` deployed the Bazel-tested archives to
the `bobr-web` and `bobr-docs` projects on 2026-10-26. Settings live on the
`preview` and `production` GitHub environments.

| Commit                    | Web                                   | Docs                                  | Run                                                                             |
| ------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| First preview deploy      | created                               | created                               | [40367521569](https://github.com/IShotTheSheriff/bobr/actions/runs/40367521569) |
| Archives unchanged        | reused                                | reused                                | [40368089412](https://github.com/IShotTheSheriff/bobr/actions/runs/40368089412) |
| Body of `sub` only        | reused                                | new deployment                        | [40369026997](https://github.com/IShotTheSheriff/bobr/actions/runs/40369026997) |
| Revert of that change     | reused                                | reused its first deployment           | [40369528742](https://github.com/IShotTheSheriff/bobr/actions/runs/40369528742) |
| Merge into `main`         | created production                    | created production                    | [40371556470](https://github.com/IShotTheSheriff/bobr/actions/runs/40371556470) |
| Docs edit on `main`       | created production, live check passed | created production, live check passed | [40373598068](https://github.com/IShotTheSheriff/bobr/actions/runs/40373598068) |
| Reuse key ignores `crons` | created production, live check passed | created production, live check passed | [40374236995](https://github.com/IShotTheSheriff/bobr/actions/runs/40374236995) |
| Docs edit after the fix   | reused production, live check passed  | reused production, live check passed  | [40374730840](https://github.com/IShotTheSheriff/bobr/actions/runs/40374730840) |
| Final code on `bazel`     | created preview, live check passed    | created preview, live check passed    | [40375231811](https://github.com/IShotTheSheriff/bobr/actions/runs/40375231811) |

Vercel accepted each archive as prebuilt output, and the deployments were ready
in about 10 seconds. Between deploys, only `latestDeployments` and `targets`
changed in the project records, and the reuse key ignores both. The first
attempt exposed two problems, now fixed. Vercel makes a project's first
deployment production unless the request names a target, so a preview build
from `bazel` became `bobr-web`'s production deployment; preview deploys now pass
`--target preview`. The deploy matrix also cancelled docs when web failed; apps
now deploy independently.

The live check passes for production. With each project's automation bypass
secret, it requested `/`, `/demo`, `/api/hello`, a missing page and five static
assets from both apps, and every status, title and API body matched the tested
archive. The docs edit on `main` should have reused both production deployments
but created new ones. The project's `crons` record stores the current
production deployment's ID, so the reuse key changed with every production
deploy. The key now ignores it, and the next docs edit reused both production
deployments.

CI's build job has used Vercel's Remote Cache since 2026-10-29. It reads the
deploy environment's `VERCEL_TOKEN` with `deployment: false`, and the
repository secret `BAZEL_CACHE_SIGNING_KEY` turns the cache on. The first run
with something to build was a docs test edit. It ran only the docs unit test,
type check and lint. The proxy looked their 6 steps up in Vercel, found none
and uploaded 25 signed files
([40899648722](https://github.com/IShotTheSheriff/bobr/actions/runs/40899648722)).
CI's disk cache answers first, so a commit that builds nothing sends Vercel no
requests.

## Shared cache through Vercel

Developers share Bazel results through the team's Vercel Remote Cache. On
2026-10-27, two Bazel clients on one Mac, each with its own output base and no
disk cache, built the Next apps and their tests:

| Client       | Next builds and tests          | Vercel cache                  |
| ------------ | ------------------------------ | ----------------------------- |
| `team-mac-1` | ran                            | 0 hits, 10 misses, 44 uploads |
| `team-mac-2` | all restored, 0 of 4 tests run | 26 hits, 0 misses, 0 uploads  |

The second client needed about 50 requests, inside the Hobby plan's 100 a
minute. The same check in CI's mode used a throwaway signing key. A writer
uploaded 27 signed files, and a fresh reader with that key restored both Next
builds and both browser tests (18 hits, 0 misses). A reader with a different
key ignored the 2 signed action results it found and rebuilt, so Vercel keeps
the signature header and CI refuses results it did not sign.

GitHub Actions repeated the developer path on two separate runners
([40459620909](https://github.com/IShotTheSheriff/bobr/actions/runs/40459620909)).
The first, with no disk cache, built the Next apps and their tests and uploaded
60 files. The second, a fresh runner with no disk cache and no browser
libraries, restored both Next builds, both browser tests, both type checks and
both unit tests: 34 hits, 0 misses and 0 of 6 tests run. The workflow
`vercel-cache.yml` repeats this when the cache code changes and every week. On
2026-10-29 both runners found every result in Vercel, with 34 hits, 0 misses
and 0 uploads each, and the fresh runner ran 0 of its 8 Next builds and checks
([40891010840](https://github.com/IShotTheSheriff/bobr/actions/runs/40891010840)).
After the docs test edit, only CI's namespace held that code's docs unit test
and type check, because only CI had built them. The next run's first runner,
on the developer path with no disk cache, still built nothing, with 34 hits
and 0 misses
([40900397649](https://github.com/IShotTheSheriff/bobr/actions/runs/40900397649)).
A developer's Linux machine therefore reuses CI's uploads.

Two Macs also shared results. A developer Mac uploaded the Next builds and test
results through the wrapper at commit `a7e8b67`. A fresh `macos-latest` runner,
a different Mac with no Bazel state and no disk cache, then restored all 8:
34 hits, 0 misses and 0 of 6 tests run
([40469246302](https://github.com/IShotTheSheriff/bobr/actions/runs/40469246302)).
`vercel-cache-mac.yml` repeats that restore on demand. On 2026-10-29 it
restored all 8 again from the same uploads
([40889445293](https://github.com/IShotTheSheriff/bobr/actions/runs/40889445293)).

A login older than the CLI's token lifetime returned HTTP 403, so the
wrapper now runs `vercel whoami`, which renews the login before reading it. If
the cache is unreachable, the wrapper builds locally instead of failing. The
self-hosted server in `infra/bazel-cache` remains an alternative and passed its
acceptance test on GitHub Actions
([39994616799](https://github.com/IShotTheSheriff/bobr/actions/runs/39994616799)).

## Rollback on Vercel

After an [Instant Rollback](https://vercel.com/docs/deployments/instant-rollback),
Vercel keeps production on the rolled-back deployment until someone promotes a
newer one. CI must not undo that decision. On 2026-10-27 `bobr-web` was rolled
back from `bobr-cbgrlomjb` to the older `bobr-ks86i2lf8`, whose archive predates
the current build.

| Step                            | Result                                                                                                                                     | Run                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Docs edit while rolled back     | Web created `bobr-1sm33vshp` instead of reusing, warned that production still serves the rolled-back deployment and named `vercel promote` | [40468109569](https://github.com/IShotTheSheriff/bobr/actions/runs/40468109569) |
| `vercel promote bobr-1sm33vshp` | Production serves the tested build again                                                                                                   | local                                                                           |
| First push after the promotion  | Web created `bobr-302phqpmt` instead of reusing `bobr-1sm33vshp`, without a warning                                                        | [40468413605](https://github.com/IShotTheSheriff/bobr/actions/runs/40468413605) |
| Next push                       | Web reused `bobr-302phqpmt`                                                                                                                | [40468744082](https://github.com/IShotTheSheriff/bobr/actions/runs/40468744082) |

The live check passed on each new deployment, and docs reused its production
deployment throughout. A deployment created while production is rolled back is
not reused after the promotion: the project record differs during a rollback,
and the reuse key treats any project setting change as a reason to redeploy.
That costs one extra deployment and never serves an untested build.
