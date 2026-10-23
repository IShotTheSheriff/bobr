# Bóbr

Bóbr tests whether a TypeScript monorepo can skip work when shared code changes
without affecting an app. Bazel owns cache keys. Developers write ordinary
imports, including imports through a barrel.

## Development and CI

```bash
pnpm install
pnpm dev                     # Next dev servers use the original sources
pnpm build                   # Bazel builds both Vercel artifacts
pnpm test                    # Unit, projection and artifact browser tests
pnpm e2e:test                # Just the artifact browser tests
pnpm test:bazel-next          # Disposable mutation and remote-cache experiment
```

Install Bazelisk before using the Bazel commands. The browser targets support
Linux x64 and macOS arm64. Linux also needs Chromium's system libraries, which
CI installs with the pinned Playwright CLI. Locally, run
`pnpm --filter @repo/web-e2e exec playwright install-deps chromium`.
Bazel downloads the pinned browser. After updating Playwright, run
`node scripts/update-chromium.cjs` to generate its version and archive hashes.

`pnpm build`, `pnpm test` and CI use `scripts/bazel.py`. It reads shared-cache
configuration from the environment and otherwise uses the local disk cache.
Developers do not calculate build hashes. `pnpm dev` does not populate production
build cache entries. Run `pnpm build` or `pnpm test` to do that.

## The build boundary

```text
App imports + complete UI sources
             |
       UiProjection, esbuild
             |
  App-specific ui_runtime tree
             |
  NextBuild, vercel build --standalone
             |
     .next + vercel_output.tar
                    |
           Playwright artifact tests
                    |
           vercel deploy --prebuilt
```

`UiProjection` follows imports into reachable UI components and bundles the
utility barrel with only the requested exports. Unreachable component files
never enter Next's input tree. Reachable React files retain their directives
and contents. Utility module side effects remain, including effects in unused
barrel branches and relative side-effect imports. The projection ignores
`sideEffects: false` and `PURE` annotations when retaining those effects.

An unused export edit reruns the projection. If it produces identical files,
Bazel reuses the existing Next and Vercel output and cached browser test result.
Next's output can be nondeterministic because no second Next build executes on
that cache hit. No output normalization or developer-maintained semantic hashes
control this decision.

The tests run the generated Vercel function handlers and static files from an
isolated copy. They check hydration, calculator updates, navigation, API calls
and 404 responses. The local adapter implements this PoC's routes; a hosted
preview still needs validation against Vercel's routing and environment.

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
intended Vercel account, projects and credentials are configured.

The selected shared cache is self-hosted on AWS. Its
[EC2 and Docker setup](infra/bazel-cache/README.md) includes automatic HTTPS,
separate reader/writer credentials and an acceptance test using fresh clients.
AWS provisioning still needs an account and cache domain. Deployment reuse is
implemented but still needs verification against the hosted Vercel projects.

This remains a bounded PoC. It shakes utility exports, not individual exports
inside reachable React component modules. Namespace imports retain all utility
exports. Unsupported computed imports, asset lookups, utility leaf imports and
shared UI styles fail explicitly. New app source directories, framework hooks,
npm dependencies and Bazel subpackages can require build-rule changes.
Build-time environment values and fetched content must become declared inputs
before adding them to these apps. Full source type checks run separately in CI.

See [the evaluation](spec/BAZEL_EVALUATION.md) for evidence and remaining gaps.
[The migration notes](spec/BAZEL_MIGRATION.md) describe the original graph.
[The optimization plan](spec/OPTIMIZATION_PLAN.md) and
[hashing strategy](spec/HASHING_STRATEGY.md) record the earlier Nx approach.
