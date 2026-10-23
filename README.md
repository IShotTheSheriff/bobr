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
| Type check    | `//apps/web:typecheck`           | App files and the UI types the app reaches      |
| Lint          | `//apps/web:lint`                | App files and the ESLint config                 |
| Unit test     | `//apps/web:lib/calculator.test` | One esbuild bundle of the code the test reaches |
| Browser test  | `//packages/web-e2e:test`        | The Vercel deployment archive                   |
| Library tests | `//packages/ui:typecheck`, ...   | The shared UI package's own sources             |

Install Bazelisk before using the Bazel commands. The browser targets support
Linux x64 and macOS arm64. Linux also needs Chromium's system libraries, which
CI installs with the pinned Playwright CLI. Locally, run
`pnpm --filter @repo/web-e2e exec playwright install-deps chromium`.
Bazel downloads the pinned browser. After updating Playwright, run
`node scripts/update-chromium.cjs` to generate its version and archive hashes.

`pnpm build`, `pnpm test` and CI use `scripts/bazel.py`. It reads shared-cache
configuration from the environment and otherwise uses the local disk cache.
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
package, and it needs its own Vercel project.

CI writes a table to each run's summary page that lists the Next builds and
checks that ran, and the ones Bazel reused from cache.

## The build boundary

```text
App imports + complete UI sources
             |
   UiProjection and UiTypes, esbuild and tsc
             |                         \
  App-specific ui_runtime tree     ui_types tree (components + declarations)
             |                           |
  NextBuild, vercel build --standalone   app type check
             |
     .next + vercel_output.tar
                    |
           Playwright artifact tests
                    |
           vercel deploy --prebuilt
```

`UiProjection` follows imports from Next's entry files (`app/`, `pages/`,
`middleware`, `proxy` and `instrumentation`) into reachable UI components. It
bundles the utility barrel with only the requested exports. Unreachable
component files never enter Next's input tree. Reachable React files retain
their directives and contents. Utility module side effects remain, including
effects in unused barrel branches and relative side-effect imports. The
projection ignores `sideEffects: false` and `PURE` annotations when retaining
those effects.

`UiTypes` builds the type checker's view of the same package. It copies the
components the app's code and tests reach, including type-only imports, and
writes declarations for only the utility exports the app names. A body change in
a shared utility leaves every app's type check cached. A signature change reruns
only the apps that import that utility.

An unused export edit reruns the projection. If it produces identical files,
Bazel reuses the existing Next and Vercel output and cached browser test result.
Next's output can be nondeterministic because no second Next build executes on
that cache hit. No output normalization or developer-maintained semantic hashes
control this decision.

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
| Comment in a shared utility               | nothing                                | nothing                                   |
| New utility module that no app imports    | nothing                                | nothing                                   |
| UI component that no app renders          | nothing                                | nothing                                   |
| UI component that only web renders        | build, browser tests, type check       | nothing                                   |
| Unused export added to that web component | build, browser tests, type check       | nothing                                   |
| New npm dependency used by docs           | nothing                                | build, browser tests, type check, lint    |
| New folder and component in web           | build, browser tests, type check, lint | nothing                                   |
| App README                                | nothing                                | nothing                                   |
| Shared ESLint rule                        | lint                                   | lint                                      |
| Shared tsconfig                           | everything                             | everything                                |

Any edit to `packages/ui` also reruns that package's own type check and lint.
Unit tests in `packages/ui` rerun only when the module they test changes.

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
| Add or change a reachable module side effect        | Execute                     | Execute                      |
| Start a fresh client with only HTTP cache access    | Cache hit                   | Cache hit                    |
| Edit an unused export on another fresh client       | Cache hit                   | Cache hit                    |

The HTTP fixture uses separate producer and consumer Bazel output bases, no
disk cache, and a consumer that cannot upload results. This tests the remote
cache protocol locally. It does not establish access to a hosted cache provider.
The expensive experiment runs for build-system changes, weekly, or manually.
Follow-up PR commits compare against the previous head so ordinary app edits
can skip the experiment.

## Deployment and limits

See [the setup guide](spec/BAZEL_DEPLOYMENT.md) for the shared cache, Vercel
account and GitHub configuration. CI packages the tested Linux artifact and
can deploy it without another build. Deployment stays disabled until the
repository has the Vercel token and project settings.

The selected shared cache is self-hosted on AWS. Its
[EC2 and Docker setup](infra/bazel-cache/README.md) includes automatic HTTPS,
separate reader/writer credentials and an acceptance test using fresh clients.
AWS provisioning still needs an account and cache domain. Until then, CI keeps
Bazel's disk cache in the GitHub Actions cache, which pull requests read from
`main`.

This remains a bounded PoC. Component files count whole, so an unused export
added to a component that an app renders reruns that app. Namespace imports
retain all utility exports. Unsupported computed imports, asset lookups, utility
leaf imports and shared UI styles fail explicitly. A new shared workspace package
gets checks from `shared_package()`, but apps consume it whole until the
projection covers it. `.env` files in an app are build inputs. Values from the
CI environment or the network are not, so declare them before an app reads them.

See [the evaluation](spec/BAZEL_EVALUATION.md) for evidence and remaining gaps.
[The migration notes](spec/BAZEL_MIGRATION.md) describe the original graph.
[The optimization plan](spec/OPTIMIZATION_PLAN.md) and
[hashing strategy](spec/HASHING_STRATEGY.md) record the earlier Nx approach.
