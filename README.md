# Bóbr

Bóbr tests whether a TypeScript monorepo can skip work when shared code changes
without affecting an app. Bazel owns cache keys. Developers write ordinary
imports, including imports through a barrel.

## Development and CI

```bash
pnpm install
pnpm dev                     # Next dev servers use the original sources
pnpm build                   # Bazel builds both Vercel artifacts
pnpm test                    # Every check, each rerun only when its inputs change
pnpm e2e:test                # Just the artifact browser tests
pnpm test:bazel-next          # Disposable mutation and remote-cache experiment
```

`pnpm test` runs these checks as Bazel tests:

| Check         | Example target                   | What it reads                                   |
| ------------- | -------------------------------- | ----------------------------------------------- |
| Type check    | `//apps/web:typecheck`           | App files and the shared types the app reaches  |
| Lint          | `//apps/web:lint`                | App files and the ESLint config                 |
| Unit test     | `//apps/web:lib/calculator.test` | One esbuild bundle of the code the test reaches |
| Browser test  | `//packages/web-e2e:test`        | The Vercel deployment archive                   |
| Library tests | `//packages/ui:typecheck`, ...   | The shared UI package's own sources             |

Install Bazelisk before using the Bazel commands. The browser targets support
Linux x64 and macOS arm64. Linux also needs Chromium's system libraries, which
CI installs with the pinned Playwright CLI. Locally, run
`pnpm --filter @repo/web-e2e exec playwright install-deps chromium`.
Bazel downloads the pinned browser. After updating Playwright, run
`node scripts/update-chromium.ts` to generate its version and archive hashes.

`pnpm build`, `pnpm test` and CI use `scripts/bazel.py`. If you are logged into
the Vercel CLI, it shares Next builds and test results with your teammates
through the team's Vercel Remote Cache. Run `vercel login` once; set
`BAZEL_REMOTE_CACHE=off` to build without it. See
[the setup guide](spec/BAZEL_DEPLOYMENT.md#configure-the-shared-cache).
`pnpm dev` does not populate production build cache entries. Run `pnpm build` or
`pnpm test` to do that.

## What developers edit

Code and `package.json`. Bazel reads everything else from the files:

- New pages, routes, folders, components and utilities need no BUILD change.
- Every `*.test.ts` or `*.test.tsx` file becomes a cached test target.
- npm dependencies come from `pnpm-lock.yaml` after `pnpm install`.
- tsconfig `paths` aliases such as `@/*` resolve the way TypeScript resolves them.
- Nobody calculates or commits a hash. Bazel derives every key from file contents.

Each app's `BUILD.bazel` is four lines that call `next_app()`. A shared package
calls `shared_package()`. A new app copies `apps/web/BUILD.bazel` and an e2e
package, and it needs its own Vercel project. If a package under `apps/` or
`packages/` has no `BUILD.bazel`, `//:build_files_test` fails and names the file
to copy. Without that check Bazel would skip the package and CI would still pass.

CI writes a table to each run's summary page that lists the Next builds and
checks that ran, and the ones Bazel reused from cache.

## The build boundary

```text
App entries + the workspace packages in its dependencies
             |
   Projection and TypesProjection (tools/bazel/projection.ts)
             |                              \
  node_modules/.projection/runtime     node_modules/.projection/types
             |                              |
  NextBuild, vercel build --standalone      app type check
             |
        vercel_output.tar
                    |
           Playwright artifact tests
                    |
           vercel deploy --prebuilt
```

`Projection` starts at the files Next compiles by convention: App Router and
Pages files for the app's `pageExtensions`, `middleware`, `proxy`,
`instrumentation` and `next.config`. It follows imports into every workspace
package in the app's `dependencies` and into the workspace packages those
depend on. Resolution follows `exports` and `imports` with their conditions,
wildcards and null targets, tsconfig `paths`, and `.js` specifiers that point
at `.ts` files.

Every module keeps its path and its text. A file Next must compile as a whole is
copied byte for byte: JSX, a `"use client"` or `"use server"` directive,
CommonJS, styles and assets. Other modules lose the top-level statements that no
used export reaches and that cannot run code. They also lose comments and
indentation, so a comment edit inside a used function changes nothing. An unused
import of a module that the package's `sideEffects` field marks as free of
effects disappears, as Turbopack drops it. Other unused imports stay as a bare
`import "x"`. An initializer that can run code stays unless `/*#__PURE__*/`
marks it.

Styles follow `@import`, `@use`, `url()` and CSS modules' `composes`. A
directory Tailwind scans through `@source`, `source()` or a Tailwind 3 `content`
glob is copied whole, because its files must match the source byte for byte.

The Next build copies the projected packages to their own directories, such as
`packages/ui`, and links them from the app's `node_modules` as pnpm does.
Modules resolve, and Next names them, exactly as in a build of the whole
repository. `next.config.js` needs no alias.

`TypesProjection` builds the type checker's view the same way, type-only imports
included. A module TypeScript can emit declarations for becomes those
declarations, cut down to the names the app uses. A body change in a shared
utility leaves every app's type check cached. A signature change reruns only the
apps that import that utility. Components stay whole.

Some code names its files at runtime: `import(name)` or `require(name)` with no
static prefix, `fs` reads, `import.meta.url`, `__dirname` and a computed
`require.resolve`. The projection then copies the module's directory, or the
whole package for a computed import, and writes a line to its report,
`node_modules/.projection/<mode>.json` next to the tree. Next never reads the
report, and CI's run summary prints it for each app. `--define=projection=strict`
turns every fallback into an error.

An unused export edit reruns the projection. If it produces identical files,
Bazel reuses the existing Next and Vercel output and cached browser test result.
Next's output can be nondeterministic because no second Next build executes on
that cache hit. No output normalization or developer-maintained semantic hashes
control this decision.

The projection is a model of what Next reads, so it has an oracle.
`//apps/web:equivalence_test` builds the app once more, against every workspace
package whole, and compares that archive with the projected build's. Turbopack
names chunks by their content and modules by their path under the build root,
so the comparison replaces only sandbox paths and the secrets Next generates
for every build. A difference means the projection dropped something Next
reads, such as a Tailwind class. The test is manual. CI runs it weekly and
whenever the build setup changes:

```bash
bazel test //apps/web:equivalence_test //apps/docs:equivalence_test
```

The tests run the generated Vercel function handlers and static files from an
isolated copy. They check hydration, calculator updates, navigation, API calls
and 404 responses. The local adapter implements this PoC's routes; a hosted
preview still needs validation against Vercel's routing and environment.

## What reruns

Each row is one edit, measured with Bazel's execution log after a full cached
run.

| Edit                                      | Web                                    | Docs                                      |
| ----------------------------------------- | -------------------------------------- | ----------------------------------------- |
| Body of `sub`, which only docs uses       | nothing                                | build, browser and unit tests             |
| Body of `add`, which only web uses        | build, browser and unit tests          | nothing                                   |
| Signature of `sub`                        | nothing                                | build, browser and unit tests, type check |
| Comment inside a used shared function     | nothing                                | nothing                                   |
| New utility module that no app imports    | nothing                                | nothing                                   |
| UI component that no app renders          | nothing                                | nothing                                   |
| UI component that only web renders        | build, browser tests, type check       | nothing                                   |
| Second export added to that web component | build, browser tests, type check       | nothing                                   |
| New npm dependency used by docs           | nothing                                | build, browser tests, type check, lint    |
| New folder and component in web           | build, browser tests, type check, lint | nothing                                   |
| App README                                | nothing                                | nothing                                   |
| Shared ESLint rule                        | lint                                   | lint                                      |
| Shared tsconfig                           | everything                             | everything                                |

Any edit to `packages/ui` also reruns that package's own type check and lint.
Unit tests in `packages/ui` rerun only when the module they test changes.
GitHub Actions runs on fresh Linux runners showed the same result; the
[evaluation](spec/BAZEL_EVALUATION.md#verification-on-2026-10-23) links them.

## Prove invalidation

```bash
# No pnpm install required; Bazel supplies the build tools.
python3 scripts/prove-next-invalidation.py --remote --browser
```

The proof changes only a disposable copy of the working tree. It checks actual
`NextBuild` and `TestRunner` actions, compares complete intermediate and output
trees and deployment archive bytes, and saves JSON evidence with execution logs.

| Edit                                                | Web build and browser tests | Docs build and browser tests |
| --------------------------------------------------- | --------------------------- | ---------------------------- |
| Add or change an unreachable UI component           | Reused                      | Reused                       |
| Change an unused export through the utility barrel  | Reused                      | Reused                       |
| Change an unused export in the same module as `add` | Reused                      | Reused                       |
| Change used `add`                                   | Execute                     | Reused                       |
| Change used `sub`                                   | Reused                      | Execute                      |
| Add an effect to a module no app imports            | Reused                      | Reused                       |
| Add or change an effect in `add`'s module           | Execute                     | Reused                       |
| Change an effect behind a bare `import "./utils"`   | Reused                      | Reused                       |
| The same after removing `sideEffects` from the UI   | Execute                     | Execute                      |
| Start a fresh client with only HTTP cache access    | Cache hit                   | Cache hit                    |
| Edit an unused export on another fresh client       | Cache hit                   | Cache hit                    |

`@repo/ui` declares `"sideEffects": false`, so Turbopack drops a module whose
exports nobody uses, effects included. The two reused effect rows also run the
equivalence check, which shows that a build of the whole package drops the
effect too.

The HTTP fixture uses separate producer and consumer Bazel output bases, no
disk cache, and a consumer that cannot upload results. This tests the remote
cache protocol locally. It does not establish access to a hosted cache provider.
The expensive experiment runs for build-system changes, weekly, or manually.
Follow-up PR commits compare against the previous head so ordinary app edits
can skip the experiment.

## Deployment and limits

See [the setup guide](spec/BAZEL_DEPLOYMENT.md) for the shared cache, Vercel
account and GitHub configuration. CI packages the tested Linux artifact and
deploys it without another build: previews from branches and PRs, production
from `main`. An app whose archive did not change keeps its existing deployment,
so a shared-code change that only docs uses deploys only docs.

The selected shared cache is self-hosted on AWS. Its
[EC2 and Docker setup](infra/bazel-cache/README.md) includes automatic HTTPS,
separate reader/writer credentials and an acceptance test using fresh clients.
AWS provisioning still needs an account and cache domain. Until then, CI keeps
Bazel's disk cache in the GitHub Actions cache, which pull requests read from
`main`.

This remains a bounded PoC. Files with JSX, directives or CommonJS stay whole,
so any edit to a component file rebuilds every app that renders it. Namespace
imports keep every export. Code that finds files at runtime costs its directory
or package, and the report lists each case. A new shared workspace package gets
checks from `shared_package()`, and every app that lists it in `dependencies`
gets its projection. Workspace packages in `devDependencies`, such as the
ESLint and TypeScript configs, stay whole. `.env` files in an app are build
inputs. Values from the CI environment or the network are not, so declare them
before an app reads them.

The Next build uses Turbopack. Bazel's sandbox gives an action its inputs as
absolute symlinks into the execroot, and Turbopack refuses a symlink that
points outside its root: `Symlink [project]/apps/web/package.json is invalid,
it points out of the filesystem root`. Before the build,
`tools/bazel/materialize-inputs.ts` replaces those links with the files
themselves, as clones where the file system supports them, such as APFS, and
as hard links elsewhere. rules_js patches
Node's `fs` so that these links look like regular files, so the script runs in
a child process with the patch off. On macOS the step takes about 5 seconds
for the 23,000 files of a Next build's inputs. Remote execution workers
usually give an action regular files, so there the step should find nothing to
replace. bobr has not tested remote execution. A build with
`next build --webpack` skips the step, but the equivalence check would then
need module ids that do not depend on the sandbox path.

See [the evaluation](spec/BAZEL_EVALUATION.md) for evidence and remaining gaps.
[The migration notes](spec/BAZEL_MIGRATION.md) describe the original graph.
[The optimization plan](spec/OPTIMIZATION_PLAN.md) and
[hashing strategy](spec/HASHING_STRATEGY.md) record the earlier Nx approach.
