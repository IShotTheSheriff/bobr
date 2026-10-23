# Cache and deployment evaluation

Reviewed 2026-09-29 at commit `68d9144` against the branch, the fork's Linux CI log and official documentation. This review does not claim a new remote-cache or Vercel deployment test.

The narrow Next invalidation experiment addresses the output nondeterminism concern. The full development-to-Vercel workflow is unfinished. In particular, the checked-in CI deliberately runs eight real Next builds in its regression proof on every PR run.

The subsequent [evaluation follow-up](BAZEL_EVALUATION.md#follow-up-fixes-on-2026-09-29) separates the mutation experiment from ordinary CI, restores application type checks and fixes relative side-effect imports. The deployment and remote-cache gaps below remain open.

## What the cache boundary establishes

Bazel records an action's declared files, command and environment, then maps that action to stored outputs. A hit retrieves those outputs without executing the action. The cache does not need a fresh Next output to compare against the old one. This follows from Bazel's documented action-cache and content-store design. [Bazel remote caching](https://bazel.build/remote/caching)

The implementation gives Next the generated `ui_runtime` directory rather than the raw utility package. Its mutation proof checks action execution and complete output bytes. That is the right experiment for the unused-export requirement. See [the build macro](../tools/bazel/defs.bzl), lines 79 and 87, and [the proof](../scripts/prove-next-invalidation.py), lines 67 through 85.

The [Linux CI run](https://github.com/ernest-oneteam/bobr/actions/runs/36552236479) passed all nine proof cases and all three test targets. Its initial Actions cache lookup missed and its final step saved a new cache. This establishes Linux execution of the proof, but supplies no evidence of restoring an earlier CI run's cache.

Inference: byte variation from a cold Next build does not, by itself, prevent reuse of one complete cached artifact. This is narrower than proving arbitrary Next builds safe to share. Bazel explicitly frames safe sharing around reproducible builds and warns about undeclared tools and environment differences. The app must not depend on untracked build inputs. [Bazel remote caching](https://bazel.build/remote/caching)

## Gaps in the current workflow

| Requirement                                                  | Current evidence                                                      | Assessment                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------- |
| Skip actual Next for unused utility edits                    | Mutation script checks action execution and identical generated files | Covered by the narrow proof                    |
| Reuse cached output after deleting local Bazel outputs       | Proof uses `bazel clean` and restores from its disk cache             | Covered on the same machine and checkout path  |
| Reuse across consecutive PR commits                          | Actions restores `.bazel-cache` using prefix keys                     | Configured, not established by the local proof |
| Share dev and CI results through a remote CAS                | `.bazelrc` defines optional BuildBuddy settings                       | Not enabled by the CI commands                 |
| Skip unnecessary Next execution across the whole PR workflow | CI always invokes a fresh mutation proof                              | Not achieved                                   |
| Deploy the tested Bazel artifact to Vercel                   | Bazel produces `.next`; CI has no deployment step                     | Not implemented                                |
| Validate deployed behavior                                   | CI builds and tests source logic and the projection                   | No deployed-artifact test                      |

### Every CI run repeats eight Next builds

[CI](../.github/workflows/ci.yml), line 57, invokes the proof unconditionally. [The proof](../scripts/prove-next-invalidation.py), line 53, selects a new disk cache under its temporary directory. Its expected actions are two baseline builds, one for `add`, one for `sub`, two for the new side effect, and two for changing that effect. The test deliberately needs these executions to validate invalidation.

This is useful regression coverage, but an unused-export PR still pays for eight Next builds in that step. Move the expensive proof to changes affecting the build system or a scheduled job, or make the proof a properly declared cacheable test with fixed fixtures. Keep ordinary app builds in every PR. Acceptance must measure the whole workflow separately from the regression experiment.

### Remote sharing is optional configuration, not demonstrated behavior

[`.bazelrc`](../.bazelrc), line 41, places the remote URL under `build:remote`. [CI](../.github/workflows/ci.yml), lines 49 and 54, invokes Bazel without that configuration. CI instead archives the local disk cache using GitHub Actions. No checked-in step establishes a shared remote service between a developer laptop and CI.

The Actions prefix keys can restore earlier cache snapshots despite a different commit SHA. GitHub searches matching prefixes and limits access by branch and PR scope. A PR's cache does not automatically become available to other PRs or its base branch. Therefore the SHA suffix is not itself a defect, but comments implying unrestricted sharing across branches overstate this setup. [GitHub dependency cache reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

The optional read-only remote configuration also needs a policy for retaining new results from a PR. A reader can reuse main's artifacts but cannot populate the shared CAS with PR-specific work. The existing Actions snapshot might provide that persistence within the PR; this combination needs a two-commit test.

### macOS evidence does not establish Linux deployment portability

Each proof run uses one host and one checkout. Separate successful macOS and Linux runs do not show them sharing artifacts. The statement in [`.bazelrc`](../.bazelrc), lines 27 through 29, that an artifact built on any laptop will be fetched by all others is too broad. Different toolchains and action inputs can correctly produce different cache keys.

Vercel's Build Output API warns that native dependencies follow the build machine's architecture. It recommends Linux x64 for projects with native binaries. A macOS arm64 `.next` directory is not enough evidence for that deployment target. [Build Output API](https://vercel.com/docs/build-output-api)

### Vercel requires another artifact boundary

The current macro declares only `.next`. Vercel prebuilt deployment consumes `.vercel/output`, which follows its Build Output API. The repo has no rule producing that directory and no `vercel deploy --prebuilt` step. [Vercel deploy](https://vercel.com/docs/cli/deploy), [Build Output API](https://vercel.com/docs/build-output-api)

Vercel documents `vercel build` for producing this directory in CI. It recommends pulling project settings and environment first. Its `--standalone` option includes dependencies inside the resulting function folders so the artifact can be moved between jobs. These commands describe a supported path, but they have not been integrated here. Simply running another framework build after Bazel would need another proof that the deployed artifact is the tested one. [Vercel build](https://vercel.com/docs/cli/build)

### Build-time configuration and version identity remain unresolved

[The Next action](../tools/bazel/defs.bzl), line 92, declares four fixed environment values. It has no declared application environment file or fetched-content snapshot. Next embeds public environment values during the build. A change to such a value must change the action's declared inputs, while truly runtime-only settings can remain outside that key. [Next self-hosting](https://nextjs.org/docs/app/guides/self-hosting)

Next generates a Server Function encryption key per build and embeds it in the output. Reusing a complete artifact preserves that key; a fixed build ID alone does not make independent outputs identical. [Next self-hosting](https://nextjs.org/docs/app/guides/self-hosting)

Both app configurations always fall back to `bobr-static`. Treat this as a PoC choice, not a finished deployment identity policy. Vercel supports skew protection for prebuilt Next apps through a custom deployment ID. It also documents missing system environment values during prebuilt builds. The deployment design must account for those constraints without injecting every commit SHA into otherwise reusable build inputs. [Vercel deploy](https://vercel.com/docs/cli/deploy)

## Evidence needed to close the original goals

1. Seed a remote cache from a Linux CI build, then use a second clean runner with an empty local cache. Require zero Next executions and verify the restored artifact runs after the first checkout is unavailable.
2. Run consecutive commits on the same PR. Cover unused exports, a used export, a side effect and a build-time environment change. Record actual Next actions in the normal CI path and in any regression jobs separately.
3. Produce a complete Vercel Build Output artifact under Bazel with pinned tooling and declared project settings, build environment and external content inputs.
4. Deploy that stored artifact through `--prebuilt`, test its preview URL, and reuse it for the next unaffected PR commit. Check production separately when its build-time settings differ.
5. Define one artifact identity and attach deployment/test records to it automatically. Developers should not calculate hashes or edit export lists.
