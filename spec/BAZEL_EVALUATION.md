# Bazel goal evaluation

Updated on 2026-09-30 for PR #6. The acceptance criteria are unchanged: unused
exports must leave intermediate inputs unchanged, used exports and effects must
invalidate correctly, developers should not maintain hashes, consecutive PR
commits should reuse work, and Vercel should deploy the tested artifact.

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
| Keep source checks                   | CI type-checks the original app and UI sources separately. These type-check results are not yet Bazel-cached.                                                                                                         |

The code addresses the four open implementation areas. Hosted cache access,
Vercel routing and production deployment are not established by local tests.
Keep the PR a draft until the chosen account and provider pass those checks.

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
App files under `app/**` are conservatively roots. This is a useful bounded
optimizer, not a replacement for Next's own route and React compiler analysis.

Adding a new app source directory, framework hook, npm dependency or Bazel
subpackage can require editing the shared rules or source aggregation. Current
scripts remove manual hash work, but do not eliminate all BUILD-file maintenance.
`pnpm dev` uses source files directly; `pnpm build` and `pnpm test` populate Bazel's
production build and test caches.

Build-time environment and remote content need declared inputs before they are
introduced. Preview and production already select separate action environments.
Deploy credentials and account linkage stay outside the cached build. A fixed
Next build ID reduces churn but is not a content-derived deployment identifier.

## Hosted acceptance still required

The `bobr-web` and `bobr-docs` projects exist under `0xVentures`, and their IDs
are configured in the CI fork. Follow [the setup guide](BAZEL_DEPLOYMENT.md) to
add the deployment credential, enable deployment and configure the chosen shared
cache. Then verify preview and production separately, including the runtime
behavior of both apps.

Use consecutive PR commits to check unused-export reuse, used-export rebuilding
and effect invalidation through the configured provider. Check a clean Linux
client with local caches disabled. Confirm that an unaffected commit reuses the
existing deployment URL and that artifact or runtime configuration changes create
a new deployment. Production reuse must refer to the current deployment after a
rollback. Missing environment revision metadata deliberately disables reuse.
