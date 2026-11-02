# Turborepo & Next.js Build/Test Optimization Plan

Bazel replaced this plan, and its `build.hash` scripts no longer exist. See [the README](../README.md).

## Problem Analysis

Currently, any change in `@repo/ui` (even unused files like `src/utils/add.ts`) triggers a cache miss for:

1. `apps/web` and `apps/docs` builds.
2. `packages/web-e2e` and `packages/docs-e2e` tests.

This happens because Turborepo uses **input-based hashing**. When a dependency (`@repo/ui`) changes, the hash of dependent tasks (`web#build`) changes. Since `e2e:test` depends on `^build`, its hash also changes, causing a full re-run.

## Goals

1. **Ideal**: Avoid rebuilds if changes in `ui` are unused. (Difficult with current toolchain as Turborepo tracks file changes, not semantic usage).
2. **Fallback**: Ensure **deterministic builds** and **reuse test cache** if the build artifact is identical.

## Solution Implemented

### 1. Optimize Build Determinism (Tree Shaking)

To ensure that adding unused files to `ui` doesn't change the _content_ of the `web`/`docs` build artifacts, we enforced strict tree-shaking.

- **Configuration**: `optimizePackageImports` in `next.config.js` for `web` and `docs`.
- **Package Config**: Marked `@repo/ui` as `"sideEffects": false`.
- **Build Tool**: Enabled **Turbopack** (`--turbo`).

### 2. Decoupling Test Caching (Smart Test Runner)

We implemented a custom "Smart Test Runner" strategy to decouple `e2e:test` invalidation from `build` invalidation.

**The Mechanism**:

1.  **Script**: `scripts/hash-build.ts` calculates a content hash of the `.next` build directory (excluding volatile cache).
2.  **Sync**: It writes this hash to `packages/*/build.hash` only if the content actually changed.
3.  **Turbo Config**:
    - Removed `dependsOn: ["^build"]` from `e2e:test`.
    - Added `inputs: ["build.hash"]` to `e2e:test`.
4.  **Workflow**: Added a root script `e2e:test` that runs:
    ```bash
    turbo run build && bun scripts/hash-build.ts && turbo run e2e:test
    ```

**Result**:

- If you change `ui/add.ts`:
  1. `turbo build` runs (cache miss, correct).
  2. Build output (`.next`) is identical (thanks to tree-shaking).
  3. `hash-build.ts` sees no change in hash. `build.hash` is untouched.
  4. `turbo run e2e:test` runs. Inputs (`build.hash`) are unchanged.
  5. **CACHE HIT!**

## Usage

Run the tests using the root script:

```bash
bun e2e:test
```

_(Do not run `bun turbo e2e:test` directly unless you are sure the build is fresh and hash is synced)._

## Limitations & Trade-offs

- **Turborepo Caching**: Turborepo is conservative. If `packages/ui` changes, `web#build` _will_ invalidate. This is by design to ensure correctness.
- **Cache Reuse**: Without a custom script, `e2e:test` will invalidate if `build` invalidates. However, with `optimizePackageImports`, the `build` process itself should be robust and produce consistent output.
- **Verification**: Use `git status` or checksums to verify `.next` folder consistency.
