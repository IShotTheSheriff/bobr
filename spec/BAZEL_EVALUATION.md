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
| Ignore unreachable UI components     | Traversal starts at app imports. Unreachable files and their utility imports do not enter Next inputs. Reachable React modules remain whole files.                                                                    |
| Reuse nondeterministic Next output   | Bazel reuses the stored action output when projected inputs match. It never compares two independently rebuilt Next outputs to decide reuse.                                                                          |
| Share build results                  | Normal package commands and CI use the shared-cache wrapper. Fresh clients restore Next and browser actions through the actual Caddy/bazel-remote stack with disk caching disabled. AWS provisioning remains pending. |
| Preserve browser coverage            | Two Bazel targets test the deployment archive, covering hydration, interaction, navigation, API and 404 behavior.                                                                                                     |
| Deploy the tested artifact           | Bazel creates the Vercel archive; CI tests, uploads and deploys it with `--prebuilt`. The intended Vercel projects exist; hosted deployment awaits its CI credential.                                                 |
| Avoid duplicate deployments          | Reuse checks match archive bytes, settings, environment versions and PR scope against a ready deployment. Unit tests pass; hosted verification remains pending.                                                       |
| Avoid manual hashes                  | Bazel owns action keys. The browser pin updater generates download hashes. Evidence hashes are assertions, not build inputs maintained by developers.                                                                 |
| Avoid build-rule edits               | `next_app()` and `shared_package()` take inputs from each package's files and npm links from `pnpm-lock.yaml`. New pages, folders, utilities, tests and npm dependencies need no BUILD change.                        |
| Cache every check                    | Type checks, lint and unit tests are Bazel tests. App type checks read declarations for the UI exports they name. Unit tests read an esbuild bundle of the code they reach.                                           |

The code addresses the four open implementation areas. Hosted cache access,
Vercel routing and production deployment are not established by local tests.
Keep the PR a draft until the chosen account and provider pass those checks.

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

In the `sub` run, web's Next build, browser test, type check, lint and unit test
all came from the cache, as did docs' type check and lint.

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

The earlier [Linux CI run](https://github.com/ernest-oneteam/bobr/actions/runs/36555048582)
restored the cache from the previous commit and reported 267 disk-cache hits.
That established cross-commit reuse through the GitHub Actions archive for the
previous build graph. It did not test HTTP remote caching or Vercel artifacts.

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

Unreachable modules are excluded, but unused exports inside a reachable React
module can still invalidate Next. Namespace utility imports retain every export.
Files under `app/` and `pages/`, plus `middleware`, `proxy` and
`instrumentation` files, are conservatively roots. Other app folders count when
a root imports them, through relative paths or tsconfig `paths`. This is a useful
bounded optimizer, not a replacement for Next's own route and React compiler
analysis.

Routine edits need no rule changes. A new app still needs a copied four-line
BUILD file, an e2e package and a Vercel project. A new shared package gets its
checks from `shared_package()`, but apps consume it as a whole package until the
projection covers it. `pnpm dev` uses source files directly; `pnpm build` and
`pnpm test` populate Bazel's production build and test caches.

Build-time environment and remote content need declared inputs before they are
introduced. Preview and production already select separate action environments.
Deploy credentials and account linkage stay outside the cached build. A fixed
Next build ID reduces churn but is not a content-derived deployment identifier.

## Hosted acceptance still required

The `bobr-web` and `bobr-docs` projects exist under `0xVentures`. CI now runs on
`IShotTheSheriff/bobr`, so the project IDs, deployment credential and deploy
switch belong there. Follow [the setup guide](BAZEL_DEPLOYMENT.md) to add them
and configure the chosen shared cache. Then verify preview and production
separately, including the runtime behavior of both apps.

Use consecutive PR commits to check unused-export reuse, used-export rebuilding
and effect invalidation through the configured provider. Check a clean Linux
client with local caches disabled. Confirm that an unaffected commit reuses the
existing deployment URL and that artifact or runtime configuration changes create
a new deployment. Production reuse must refer to the current deployment after a
rollback. Missing environment revision metadata deliberately disables reuse.
