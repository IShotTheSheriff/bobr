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

Both apps call `next_app()` from `tools/bazel/defs.bzl`. Two of its actions
decide whether Next runs:

1. `Projection` reads the app and every workspace package in its
   `dependencies`. It follows imports from Next's entry files and writes the
   modules the app reaches under `node_modules/.projection/runtime`, at their
   own paths. Files with JSX or directives stay whole. Utility modules keep only
   the statements a used export reaches.
2. `NextBuild` copies the projected packages to their directories in the
   sandbox and links them from the app's `node_modules`. The raw packages are
   absent from this action's inputs. Next emits the complete `.next` tree
   without output normalization.

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
| Effect added in a module no app imports | Both | Neither |
| Effect added to `add`'s module, then changed | Both | Web |
| `bazel clean`, then build | Neither | Neither, both restored from disk cache |
| Effect behind a bare `import "./utils"` changes | Both | Neither |
| `sideEffects` removed from `@repo/ui`, then that effect changes | Both | Both |

`@repo/ui` declares `"sideEffects": false`, so webpack drops a module no import
uses, effects included. For the two effect rows where Next does not run, the
script also runs the equivalence check, which builds both apps against the whole
package and finds the same archives. An effect that reaches a bundle must appear
in the emitted browser chunks. The script's hashes are assertions, not cache
keys supplied to Bazel.

### Supported code and fallbacks

[The build boundary](../README.md#the-build-boundary) lists what the projection
follows and where it falls back wide. `//tools/bazel:projection_test` pairs each
precision claim with a runtime check: it bundles the app against the projection
and against the whole packages with esbuild and compares what the bundles do.
`//apps/web:equivalence_test` and `//apps/docs:equivalence_test` do the same
with real Next builds. Next skips app type checking, so the app `typecheck`
targets check the applications against the types projection.

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
