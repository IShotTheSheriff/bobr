# Bazel migration

These notes describe the original migration. For current commands, cache credentials and deployment, use [the README](../README.md) and [setup guide](BAZEL_DEPLOYMENT.md).

Bóbr has two cache experiments. The TypeScript targets demonstrate dependency
isolation and identical-output reuse for utility tests. The Next targets add an
app-specific utility projection so unused barrel exports can change without
executing Next at all.

Run `python3 scripts/prove-next-invalidation.py` for the real Next proof. It
checks unused exports, used exports, side effects, and disk-cache restoration.
Remote artifact portability and Vercel deployment remain unverified.

## 1. The problem we started with

The original PoC (Nx, previously Turborepo) relied on two fragile pillars:

1. **Tree-shaking** (`optimizePackageImports` + `sideEffects:false`) so an unused
   export wouldn't change a bundle.
2. **`scripts/hash-build.ts`** — a content hash of each app's `.next` directory
   that *strips* volatile files (`BUILD_ID`, manifests, `server/app/*`, …) and
   writes a `build.hash` that Nx then uses as the e2e cache key.

That second pillar is the "optimistic hashing that might miss Next-specific
stuff" worry: it's a hand-maintained guess about which output bytes matter. It
breaks down with multiple PRs/branches (Nx's local cache isn't shared/consistent
the way a content-addressed cache is) and it can produce both false cache hits
(skipping a test that should run) and false misses (running a test that didn't
need to).

We empirically confirmed the underlying non-determinism that forced the hack to
exist: **two clean `next build` runs of identical source produce different
`.next` trees** (different `BUILD_ID`, manifest hashes, and absolute paths leak
into `required-server-files.json` / `*.nft.json`).

## 2. What Bazel actually guarantees (verified)

Bazel keys every action on the **content digests of its inputs** (a Merkle tree),
plus the command line, mnemonic, platform, and whitelisted env. Two consequences
matter here (both verified against `bazel.build` docs + the Remote Execution API
spec):

1. **Dependency-graph caching.** If a file is not in target B's transitive
   declared inputs, changing it cannot change B's action key. B is a cache hit
   and does not re-run. *(This is correct as long as deps are declared
   precisely — "the graph of actual dependencies must be a subgraph of the graph
   of declared dependencies".)*

2. **Output-stable cascade.** Even when an action re-runs, downstream actions key
   on the **content** of its outputs. If the re-run produces byte-identical
   output, the downstream action key is unchanged → cache hit, no re-execution.
   *(Skyframe calls this "change pruning". The caveat: "byte-identical" must hold
   for every byte the downstream sees — embedded timestamps/paths defeat it.)*

Mechanism (1) is what the old PoC wanted from tree-shaking but couldn't
guarantee. Mechanism (2) is precisely the tradeoff you described —
*"build the affected app, but if the bundle is identical, don't rerun the
tests"* — except Bazel does it natively, with no `hash-build.ts`.

A persistent **disk cache** (`.bazelrc`: `--disk_cache=.bazel-cache`) makes these
hits survive across separate invocations locally; a **remote cache** does the
same across machines and branches in CI.

## 3. Architecture

```
packages/ui/src/utils/
  add/index.ts -> //packages/ui/src/utils/add      (ts_project, 1 file)
  sub/index.ts -> //packages/ui/src/utils/sub      (ts_project, 1 file)
  index.ts -> //packages/ui/src/utils:utils   (deps :add + :sub)  <- coupling!

apps/web/bazel/   logic.ts + logic.test.ts -> //apps/web:logic , //apps/web:test
                  deps: //packages/ui/src/utils/add        (NEVER :sub, NEVER :barrel)
apps/docs/bazel/  logic.ts + logic.test.ts -> //apps/docs:logic, //apps/docs:test
                  deps: //packages/ui/src/utils/sub        (NEVER :add, NEVER :barrel)
```

The crux is **per-file `ts_project` targets**. Because `add.ts` and `sub.ts` are
separate targets, and each app depends only on the leaf it uses, `add.ts` is
simply not in `docs`'s action graph.

The unit-test targets use leaf dependencies. The Next apps continue to import
through `@repo/ui/utils`. Their generated UI projections provide a separate
change-pruning boundary, described below.

### Why the unit tests are CommonJS

The Bazel TS layer compiles with `module: commonjs` so the emitted `.js` runs
directly under Node's test runner with no `package.json` `"type"` gymnastics.
This is fully decoupled from how Next consumes the `.ts` source (Next compiles
the source itself).

## 4. The proof (`./scripts/bazel-cache-demo.sh`)

| Change | `//apps/web:test` | `//apps/docs:test` | Why |
|---|---|---|---|
| `add.ts`, behavior-preserving (`+12` → `+6+6`) | re-runs | **(cached)** | docs never depends on `add` (mechanism 1) |
| `add.ts`, whitespace-only (compiles identical) | **(cached)** | **(cached)** | identical `add.js` → cascade (mechanism 2) |
| `sub.ts`, behavior-preserving | **(cached)** | re-runs | mirror image |

Static proof (no execution needed) via `bazel aquery`:

```
bazel aquery 'inputs(".*/utils/add\.ts", deps(//apps/docs:test))'   # -> empty
bazel aquery 'inputs(".*/utils/add\.ts", deps(//apps/web:test))'    # -> matches
```

## 5. Skip the actual Next build after an unused barrel change

Both apps use `next_app_build` from `tools/bazel/defs.bzl`. It creates two actions:

1. `UiProjection` reads the app source and complete UI package. The TypeScript
   parser discovers requested exports, then esbuild bundles the utility barrel
   into `ui_runtime/utils/index.js`. Other UI components retain their source
   files and directives.
2. `NextBuild` receives the generated tree through a webpack alias. The raw UI
   package is absent from this action's inputs. Next emits the complete `.next`
   tree without output normalization.

An unused export change invalidates the first action. When its output is
identical, Bazel skips the second action. This works before Next's random output
can affect downstream cache keys. Both actions run with Bazel's default sandbox
strategy; the old `no-sandbox` and `no-remote-cache` tags have been removed.
A fixed build ID remains, but it does not make Next output reproducible.

Run the executable proof:

```bash
python3 scripts/prove-next-invalidation.py
```

The script uses a disposable copy of the working tree. It asserts actual action
execution from `--execution_log_json_file`, compares complete projection and
Next trees, and rejects raw UI package inputs on any Next action.

| Case | Projection executes | Next executes |
|---|---|---|
| Initial build | Both | Both |
| No edit | Neither | Neither |
| Unused barrel export changes | Both | Neither |
| Unused export added to a used module | Both | Neither |
| Used `add` changes | Both | Web |
| Used `sub` changes | Both | Docs |
| Effect added in unused barrel branch | Both | Both |
| That effect changes | Both | Both |
| `bazel clean`, then build | Neither | Neither, both restored from disk cache |

The effect must also appear in the emitted browser chunks. The script's hashes
are assertions, not cache keys supplied to Bazel. An ignored, preexisting
`next-env.d.ts` is no longer required, so the proof works from a clean copy.

### Supported code and failure behavior

The projection supports static ESM imports among local `.ts` utility modules.
It ignores package `sideEffects` and `PURE` annotations so real initialization
effects survive. Named imports select exports automatically; namespace imports
and dynamic literal imports in the app conservatively retain all exports.

Direct utility subpaths, computed app imports, dynamic utility imports,
`require` or `eval` in utilities, and React/server directives in utilities fail
with an explicit error. Changed package export mappings also require updating
the projection. React modules are copied without bundling. Changes to unrelated
React components can therefore still invalidate both apps. New Bazel packages
must still be included in the UI source filegroups.

`//tools/bazel:project_ui_test` covers namespace/default exports, effects hidden
behind annotations, and unsupported constructs. The existing utility tests
remain independent. Next skips app type checking, so these checks do not prove
that the full applications type-check.

### Deployment and remote-cache limits

The proof restores the exact artifact from a local disk CAS after deleting
Bazel's build outputs. It does not prove cross-machine relocatability or Vercel
compatibility. The actions permit remote caching, but using it for deployment
still requires declaring build-time environment and fetched content and testing
artifact portability. Preview and production configurations can require distinct
keys even when the source is identical.

Vercel Build Output packaging, deployment selection, and Playwright tests against
that artifact remain separate work. Do not recover cache hits by stripping Next
manifests or server output from a hash. The projection avoids the unnecessary
build while preserving the full artifact from the previous build.

## 6. Toolchain notes

| Component | Version | Note |
|---|---|---|
| Bazel | `8.7.0` (`.bazelversion`) | rules_js needs ≥ 7.6; 8.x LTS chosen for stability |
| aspect_rules_js | `3.2.2` | consumes `pnpm-lock.yaml` via `npm_translate_lock` |
| aspect_rules_ts | `3.8.11` | `ts_project`; tsc transpiler via `.bazelrc` flag |
| rules_nodejs | `6.7.4` | Node toolchain |
| Node (Bazel) | **22 LTS** (rules_js default) | repo's Node 25 has **no** prebuilt Bazel toolchain; 25 is not registrable without a custom toolchain |
| TypeScript | `6.0.3` (`ts_version_from`) | matches the repo; `ignoreDeprecations: "6.0"` silences the `moduleResolution: node` deprecation |

- `.npmrc` must set `hoist=false` (rules_js requires a non-hoisted layout).
- `REPO.bazel` ignores `**/node_modules`, `.nx`, `.next` (Bazel 8 replacement for
  `.bazelignore`).
- First-party workspace packages each expose an `npm_package(name = "pkg", …)` so
  `workspace:*` links resolve.

## 7. Running it

```bash
bazel build //...           # build all targets
bazel test  //...           # run all checks (cached across runs via .bazel-cache)
./scripts/bazel-cache-demo.sh   # the TypeScript unit-test cache proof
python3 scripts/prove-next-invalidation.py  # the actual Next build proof
```

CI (`.github/workflows/ci.yml`) runs `bazel test //...` with a cache keyed on the
lockfiles; `restore-keys` let a PR reuse `main`'s cache, so unaffected targets
never re-run — the cross-branch consistency the old Nx cache couldn't give.
