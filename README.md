# Bóbr, byakugan branch

Bóbr tests whether a TypeScript monorepo can skip work when shared code changes
without affecting an app. On this branch [byakugan](https://github.com/IShotTheSheriff/byakugan)
computes the cache keys. `main` holds the same proof of concept on Bazel.
Developers write ordinary imports, including imports through a barrel.

## Development and CI

```bash
pnpm install
pnpm dev          # Next dev servers use the original sources
pnpm build        # Both Vercel archives, reused when their key is stored
pnpm test         # Every check, each rerun only when its key changes
pnpm e2e:test     # Just the browser tests against the archives
pnpm test:proof   # Disposable edits that prove what reruns
```

`pnpm test` runs `tools/ci/run.ts`, which finds these tasks:

| Check         | Example task                      | What its key covers                                                  |
| ------------- | --------------------------------- | -------------------------------------------------------------------- |
| Next build    | `build:web`                       | The code the app's entries reach, its Vercel settings and Vercel CLI |
| Browser test  | `browser:web`                     | The build's key and the Playwright suite                             |
| Type check    | `typecheck:web`                   | Every code file in the package and the code those files reach        |
| Lint          | `lint:web`                        | The package's own files and its ESLint config                        |
| Unit test     | `unit:web/lib/calculator.test.ts` | The code the test file reaches                                       |

Every key also covers the operating system, CPU, Node major, byakugan's version
and the scripts in `tools/ci` that run that kind of task. Before the browser
tests run for the first time, install Chromium with
`pnpm --filter @repo/web-e2e exec playwright install chromium`.

Stored archives and results live in `.cache/ci`. CI keeps that directory in the
GitHub Actions cache, and pull requests read the entries `main` saved. There is
no cache shared between developers. `main` shares Bazel's through Vercel's
Remote Cache.

CI writes a table to each run's summary page. It lists every task and whether
it ran or came from cache.

## What developers edit

Code and `package.json`. There are no build files:

- New pages, routes, folders, components and utilities need no change.
- Every `*.test.ts` or `*.test.tsx` file becomes its own unit test task.
- npm dependencies come from `pnpm-lock.yaml` after `pnpm install`.
- Nobody calculates or commits a hash. byakugan derives every key from the code.

`tools/ci/tasks.ts` reads the packages from `pnpm-workspace.yaml`. A package
that depends on `next` and has a `next.config` is an app. A package that
depends on `@playwright/test` and on an app is that app's browser suite. A new
app needs a `vercel-build.json`, a `byakugan.json`, a browser suite and its own
Vercel project.

## How a key is made

byakugan builds the graph of code a set of entry files uses. It follows imports
into workspace packages and npm packages, down to single exports inside barrel
files, and hashes the declarations it reaches. `tools/ci/tasks.ts` gives each
kind of task its own entries:

- A build starts at the files Next compiles by convention: App Router and
  Pages files, `middleware`, `proxy`, `instrumentation` and `next.config`. The
  app's `byakugan.json` adds `vercel-build.json` and the installed Vercel CLI.
- A type check starts at every code file in the package, because `tsc` reads
  every file its `tsconfig.json` includes, reached or not.
- A lint hashes the package's own files whole and starts at its ESLint
  config, so the shared ESLint config counts and the code the files import
  does not.
- A unit test starts at its test file.

Every graph also holds the `tsconfig.json` chain, `package.json` and `.env*`
files, and the installed versions of tools such as `next`, `typescript` and
`tailwindcss`. A graph that reaches a Tailwind stylesheet holds the CSS
Tailwind generates for it. Keys use paths relative to the repository, so a
second clone at another path reuses the same results.

byakugan runs on worker threads, one graph per task. For the 15 tasks here it
takes about 2.5 seconds on an Apple Silicon Mac.

## What reruns

Each row is one edit. `scripts/prove-invalidation.ts` checks every row, and
the right column shows what `main` reruns with Bazel.

| Edit                                      | Reruns on this branch                                     | Reruns with Bazel on `main`                     |
| ----------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Body of `sub`, which only docs uses       | docs build, browser, type check and unit tests            | docs build, browser and unit tests              |
| Body of `add`, which only web uses        | web build, browser, type check and unit tests             | web build, browser and unit tests               |
| Comment inside a used shared function     | web build, browser, type check and unit tests             | nothing                                         |
| New utility module that no app imports    | nothing                                                   | nothing                                         |
| UI component that no app renders          | nothing                                                   | nothing                                         |
| Unused export in a used module            | nothing                                                   | nothing                                         |
| Unused export in a component web renders  | nothing                                                   | web build, browser tests, type check            |
| New npm dependency used by docs           | docs build, browser tests, type check, lint               | docs build, browser tests, type check, lint     |
| New folder and component in web           | web build, browser tests, type check, lint                | web build, browser tests, type check, lint      |
| App README                                | nothing                                                   | nothing                                         |
| Shared ESLint rule                        | lint of every package                                     | lint of every package                           |
| Shared tsconfig                           | everything                                                | everything                                      |

Any edit to `packages/ui` also reruns that package's own type check and lint.
A unit test in `packages/ui` reruns only when the code it reaches changes.

Three rows differ from Bazel. byakugan hashes a declaration's text, comments
included, so a comment inside a used function rebuilds the app. The proof's
oracle shows that the rebuilt archive is identical, so that build was wasted.
A type check reruns when the body of a function it reaches changes, where
Bazel compiles against declarations and reruns only on a signature change.
In the other direction, byakugan splits a component file into declarations,
so a new export next to a used component changes nothing. Bazel keeps files
with JSX whole and rebuilds.

## The oracle

A key is a model of what a task reads. Bazel enforces its model with a
sandbox, so a build cannot read a file outside its inputs. byakugan has no
sandbox. If it misses an input, CI reuses a stale archive and nothing fails.

Turbopack names chunks by their content and modules by their path, so two
builds of the same tree produce the same archive apart from secrets Next
generates for every build. `tools/ci/compare-archives.ts` replaces those
secrets and compares two archives file by file. That gives the model an
oracle:

- `node tools/ci/run.ts test --verify` builds every app whose archive comes
  from cache again and fails if the two archives differ. CI does this on
  every push, so a missed input shows up on the next commit that reuses the
  archive. Pull requests skip the extra builds.
- The proof runs the same comparison after every edit.

## Prove invalidation

```bash
pnpm test:proof                                # node scripts/prove-invalidation.ts --browser
node scripts/prove-invalidation.ts --keys-only   # keys only, no builds, about a minute
```

The proof copies the working tree to a temporary directory and makes the
edits below one after another. After each edit it runs every task, checks
which ones ran, and builds every reused app again for the oracle. It saves
logs and `results.json` with every task that ran.

| Edit                                                   | Web build            | Docs build           |
| ------------------------------------------------------ | -------------------- | -------------------- |
| Add or change an unreachable UI component              | Reused               | Reused               |
| Change an unused export through the utility barrel     | Reused               | Reused               |
| Add an unused export next to `add`                     | Reused               | Reused               |
| Add an unused export next to the `Code` component      | Reused               | Reused               |
| Change used `add`                                      | Rebuilt              | Reused               |
| Change used `sub`                                      | Reused               | Rebuilt              |
| Add a comment inside used `add`                        | Rebuilt, same output | Reused               |
| Add an effect to a module no app imports               | Reused               | Reused               |
| Add or change an effect in `add`'s module              | Rebuilt              | Reused               |
| Add a component and folder to web                      | Rebuilt              | Reused               |
| Add an npm dependency that docs uses                   | Reused               | Rebuilt              |
| Change the shared tsconfig                             | Rebuilt, same output | Rebuilt, same output |
| Change an effect behind a bare `import "./utils"`      | Reused               | Reused               |
| The same after removing `sideEffects` from the UI      | Rebuilt              | Rebuilt              |
| A second clone at another path, sharing only the cache | Reused               | Reused               |

Every "Reused" also means that a fresh build matched the stored archive.
"Same output" means the oracle found the rebuilt archive identical to the one
before the edit, so the build was not needed. The tsconfig edit turns on
`noImplicitOverride`, which changes no emitted code. A key cannot know that.
`@repo/ui` declares `"sideEffects": false`, so Turbopack drops a module whose
exports nobody uses, effects included. byakugan skips such a module too, and
the oracle shows that Next agrees. When an effect does run, the proof checks
that its string reaches the browser chunks.

CI runs the proof when the build setup changes, weekly, and on request.

## Deployment and limits

See [the setup guide](spec/DEPLOYMENT.md) for the Vercel account and GitHub
configuration. CI packages the tested Linux archive and deploys it without
another build: previews from branches and PRs, production from `main`. An app
whose archive did not change keeps its existing deployment, so a shared-code
change that only docs uses deploys only docs.

byakugan is not on npm yet, so `vendor/byakugan-cli-0.1.0.tgz` holds the
package, built from byakugan's `main`. Replace it with an npm version once one
is published.

Without a sandbox, the keys cover only what byakugan can see. Environment
variables that CI sets, data a build fetches and files code reads through a
computed path are not in any key. byakugan prints a warning for computed
imports and paths. List such files under `inputs` in the package's
`byakugan.json`, and add environment variables to the key before an app reads
them. byakugan also assumes that top-level initializers such as
`export const store = createStore()` have no effects. Its
[README](https://github.com/IShotTheSheriff/byakugan#limits) lists the rest.

The builds run in the checkout itself, not in a copy. Next writes `.next` and
`next-env.d.ts` into the app, and the type check's key leaves out
`next-env.d.ts` for that reason. A Next build of either app here takes 2 to 3
seconds on a Mac. The Bazel version spends about 5 more seconds replacing the
sandbox's symlinks for Turbopack.

[The deployment guide](spec/DEPLOYMENT.md) covers Vercel.
[The optimization plan](spec/OPTIMIZATION_PLAN.md) and
[hashing strategy](spec/HASHING_STRATEGY.md) record the earlier Nx approach.
