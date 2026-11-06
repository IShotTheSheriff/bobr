# Port bobr's change detection to this monorepo

You are bringing Bazel builds with file-level change detection to this
repository. It is a large pnpm monorepo with several Next.js apps, shadcn/ui
components and multiple shared libraries. The design comes from a working proof
of concept, bobr: https://github.com/IShotTheSheriff/bobr. Clone it next to
this repo and read it before changing anything here.

The goal is that a change to shared code rebuilds and retests only the apps
that use the changed code, and that this works on the code as the team writes it
today. bobr first reached that goal only for code that followed strict rules.
It has since replaced those rules with automatic handling, so developers never
restructure code to satisfy the build. Your job is to port that version and
check it against this repository's code.

## How bobr works

Read these files in bobr, in this order:

1. `README.md`. The "What reruns" table is the behaviour to reproduce.
2. `tools/bazel/defs.bzl`. `next_app()` and `shared_package()` generate every
   target from a glob of the package, so new pages, folders and npm
   dependencies need no BUILD edits.
3. `tools/bazel/projection.ts`, with `projection-resolve.ts`,
   `projection-slice.ts` and `link-projection.ts`. The **projection**,
   explained below.
4. `scripts/prove-next-invalidation.py`. The proof that edits rebuild only the
   apps that use them, run in CI by `.github/workflows/bazel-proof.yml`.
5. `spec/BAZEL_EVALUATION.md`, especially "Remaining maintenance limits".

Bazel caches each action by the hash of its declared input files. A Next build
that took all of `@repo/ui` as input would rerun for every UI edit. So before
Next runs, the projection action reads the app's entry files, follows imports
into `@repo/ui`, and writes a smaller tree that holds only the files and utility
exports the app reaches. The Next build links that tree as the package itself
(`tools/bazel/link-projection.ts`). When an edit leaves an app's projected tree
byte-identical, Bazel skips that app's Next build, its browser tests and its
deploy. This is **early cutoff**. A second mode (`--mode=types`) writes the tree
the app's type check compiles against, holding declarations only for the
utilities the app names.

Other parts to reuse:

- Each `*.test.ts` becomes its own test, keyed on an esbuild bundle of only the
  code it reaches.
- Lint never reads UI sources, so UI edits never rerun an app's lint.
- Playwright tests run against the exact `vercel_output.tar` that gets
  deployed, using a pinned Chromium (`tools/bazel/chromium.bzl`).
- `//:build_files_test` fails when a workspace package has no BUILD file,
  because Bazel would otherwise skip that package without a warning.

## Limits in bobr to remove

bobr's first projection **failed closed**. On any pattern it could not trace, it
threw and the build stopped. That kept the proof honest, but it rejected most
real code. Each row below is one of those limits, cited at commit `338d51a`, and
the behaviour bobr has now. Use the table as a checklist: find each pattern in
this repository and confirm a test covers it.

| bobr limit (file:line at `338d51a`) | Build instead, as bobr does now |
| --- | --- |
| Only `//packages/ui` and the name `@repo/ui` are projected (`defs.bzl` `next_app`) | Project every workspace package an app depends on, found from its `package.json`, including packages that depend on other workspace packages |
| `package.json` `exports` must equal one fixed map (`project-ui.ts:69`) | Resolve `exports` as Node and TypeScript do, covering conditions, wildcards and subpaths. Also resolve `imports` (`#alias`) and tsconfig `paths` |
| A React file with a second runtime export is rejected (`:123`) | Accept it and copy the file whole. Savings at the file level are the main value. Savings at the export level are a bonus |
| The `@repo/ui` root import is rejected (`:215`), and deep utility imports are rejected (`:308`) | Follow barrels through re-export chains to the files that declare the imported names. Write a reduced barrel that re-exports only those names |
| Utilities must be local `.ts` files with no npm imports (`:411`). shadcn's `cn()` imports `clsx` and `tailwind-merge` | npm imports stay imports, so Next resolves them as in a whole build. A `.tsx` utility without JSX is sliced like a `.ts` one |
| `"use client"` in a utility is rejected (`:421`) | Treat that file as a React file and copy it whole |
| CSS reached from a UI file is rejected (`:250`) | Follow `@import` and `url()`. Copy CSS modules and the assets they reference |
| `import.meta` and `require.resolve` are rejected (`:258`) | Handle the literal forms statically, such as `new URL("./x.png", import.meta.url)` and `require.resolve("literal")` |
| Computed `import()` is rejected (`:269`) | For template literals with a static prefix, include the matching files, as webpack context modules do. Otherwise **fall back wide** |
| Entry files are a fixed list (`:22`) | Derive the list from Next's conventions and the app's `pageExtensions`, and include `next.config` imports. Check it again on every Next major |
| Builds use `next build --webpack` and a webpack alias (`vercel-build.json`, `next.config.js`) | Link the projected tree as the package itself in the action's `node_modules`, so no config hook is needed. A Turbopack build against the projection matches one against the whole package, but Turbopack rejects the symlinks of Bazel's sandbox, so bobr still builds with webpack |
| The projection ignores `sideEffects: false` and keeps unused barrel branches (`:370`) | Match the bundler. Drop exactly what webpack or Turbopack would drop, and no more |

## Fall back wide, never fail

When the projection meets something it cannot trace statically, it widens the
input instead of stopping. Widening means including the enclosing directory,
then the whole package. The build stays correct, and only the affected app loses
savings for that package. Only these cases are truly untraceable:

- `import(variable)` and `require(variable)` with no static prefix
- `fs` reads, `require.resolve` of a computed path, and other file access at
  runtime
- tools that find files by scanning directories instead of following imports,
  such as Tailwind `@source` globs and MDX content folders

Every fallback writes a line to a **projection report**, a JSON output of the
projection action that is separate from the projected tree. Next must never
read the report, so changes to it never rerun a build. Each line names the app,
the file, the pattern and how wide the fallback went. CI prints a summary per
app. Keep a strict mode that turns every fallback into an error, for tests and
for teams that want it.

Correctness always beats savings. If you can't tell whether a file is needed,
include it.

## The equivalence check

The projection is a hand-written model of what the bundler sees, so it needs an
oracle. For every app, build twice, once against the full workspace packages and
once against the projected trees. Then compare the two outputs. They must match
after normalizing chunk hashes and module ids, which differ with build paths.
bobr's `equivalence_test` and `tools/bazel/compare-archives.ts` do this. Webpack
derives some module ids from absolute paths, which differ between Bazel
sandboxes, so both equivalence builds set `BOBR_NAMED_IDS` and name modules by
path. The normalizer then replaces content hashes, sandbox paths, Next's
per-build keys and Vercel's build traces.

A difference means the projection dropped something the bundler used, such as
a CSS class, an asset or a module with side effects. Treat any difference as a
bug in the projection and fix it before any other work. Run this check in CI on
a schedule and whenever the projection or a bundler version changes. It is the
only way to catch Tailwind scanning gaps, because a missing class produces no
error.

## Work in this order

Each phase ends when its condition holds. Commit to a branch as you go, and ask
the user before pushing.

1. **Survey.** Write `spec/BAZEL_SURVEY.md` in this repo. Classify every
   workspace package as an app, a shared library or tooling. For each shared
   library, record its export map, its barrels, how many files have more than
   one runtime export, its CSS and Tailwind setup, its dynamic imports and file
   reads, and which apps consume it. Also record the bundler, the deploy target,
   the CI system and any Nx or Turborepo config. Done when every workspace
   package has a row and every untraceable pattern is counted by file.
2. **Baseline.** Build and test everything under Bazel with no projection.
   Every app should consume shared packages whole. Port `next_app()`,
   `shared_package()`, the per-file unit tests, `build_files_test` and the
   Playwright setup. Done when `bazel test //...` passes and a second run with
   no edits executes zero actions.
3. **Projection.** Port bobr's projection and its tests
   (`tools/bazel/projection.test.ts`). Check it against the limits table and
   the fallback rules above, and add a fixture for each pattern this repository
   has that bobr's tests lack.
   Done when the projection runs on every app without errors, the equivalence
   check passes for every app, and the projection report is reviewed with the
   user.
4. **Proof.** Adapt `prove-next-invalidation.py` to this repo. Pick real edits
   to a component, a utility, a barrel, a CSS file and a shared library that
   depends on another one. Write this repo's "what reruns" table from Bazel's
   execution log. Done when each row shows the expected apps rebuilding and the
   others skipping, on a fresh CI runner with a remote cache.
5. **CI and cache.** Wire the remote cache and CI. bobr proxies Vercel's Remote
   Cache only because it is on the Hobby plan. A team this size should use a
   real Bazel remote cache. Ask the user which one. Done when CI on an
   unrelated commit runs only cached actions.

## Gotchas bobr already paid for

- `--incompatible_compact_repo_mapping_manifest` is required. Without it,
  every test's repo mapping lists all npm repos, and any lockfile edit reruns
  every test.
- rules_js links a workspace package without its devDependencies. A shared
  config's plugins must be in `dependencies`.
- A js_test `entry_point` from another package must be a `js_library` with one
  file in `srcs`, and other files go in `data`.
- Bazel 8 rejects empty globs unless you pass `allow_empty = True`.
- Bazel silently skips a workspace package that has no BUILD file.
- rules_js patches `fs.promises`, but Next imports `node:fs/promises` and
  follows sandbox symlinks out of its tracing root. That drops runtime files from
  the output. bobr's `tools/bazel/trace-fs.ts` fixes it through `NODE_OPTIONS`.
- A fresh Next build is not byte-reproducible. Early cutoff comes from the
  projected input being identical, not from Next's output.
- TypeScript 6 defaults `types` to `[]`. Packages whose tests import `node:*`
  need `"types": ["node"]`.
- If this repo uses type-aware ESLint rules, lint needs the projected type tree
  as input. bobr's lint reads no UI sources, so it never hit this.
- Declare build-time environment variables and remote content as inputs before
  any build reads them. Otherwise Bazel serves a cached result that ignores
  them.
- bobr's build tools are ES-module TypeScript run by Node 24 type stripping,
  with a `package.json` containing `"type": "module"` in each tools folder.
  Type stripping rejects enums and needs `.ts` extensions on relative imports.
