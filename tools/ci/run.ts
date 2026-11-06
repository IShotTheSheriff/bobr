// Runs CI's tasks and reuses a stored result whenever its key is in the cache.
//
//   node tools/ci/run.ts build   Next builds only
//   node tools/ci/run.ts test    builds, browser tests, type checks, lint, unit tests
//
// --target preview|production  Vercel target of the builds (default preview)
// --only <prefix>              Run only tasks whose name starts with it (repeatable)
// --skip <prefix>              Leave out tasks whose name starts with it (repeatable)
// --plan                       Print which tasks would run, run nothing
// --fresh                      Ignore the cache and store nothing
// --verify                     Build every app whose archive came from cache
//                              again and fail if the two archives differ
// --out <dir>                  Copy each app's archive to <dir>/<app>.tar
// --report <file>              Write the result of every task as JSON
// --cache <dir>                Cache directory (default .cache/ci)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { compare } from "./compare-archives.ts";
import { ROOT, tasks as allTasks, warnings, type Task } from "./tasks.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string", default: process.env.DEPLOY_TARGET || "preview" },
    only: { type: "string", multiple: true },
    skip: { type: "string", multiple: true },
    plan: { type: "boolean" },
    fresh: { type: "boolean" },
    verify: { type: "boolean" },
    out: { type: "string" },
    report: { type: "string" },
    cache: { type: "string" },
  },
});
const mode = positionals[0] ?? "test";
if (mode !== "build" && mode !== "test") throw new Error(`Unknown mode ${mode}. Use build or test.`);
if (values.target !== "preview" && values.target !== "production") throw new Error("--target is preview or production");

const cache = path.resolve(values.cache || path.join(ROOT, ".cache/ci"));
const result = (task: Task) => path.join(cache, "results", task.key);
const archive = (task: Task) => path.join(cache, "archives", `${task.key}.tar`);

const started = Date.now();
const every = await allTasks(values.target);
const keyed = (Date.now() - started) / 1000;
const matches = (task: Task, prefixes: string[] | undefined) => prefixes?.some((prefix) => task.name.startsWith(prefix));
let selected = every.filter((task) => (mode === "test" || task.kind === "build") && !matches(task, values.skip));
if (values.only) {
  const wanted = selected.filter((task) => matches(task, values.only));
  // A browser test needs the archive of its build.
  const needed = new Set(wanted.flatMap((task) => (task.needs ? [task.needs] : [])));
  selected = selected.filter((task) => wanted.includes(task) || needed.has(task.name));
}
for (const warning of new Set(warnings)) console.warn(`byakugan: ${warning}`);

const stored = (task: Task) =>
  !values.fresh && fs.existsSync(result(task)) && (task.kind !== "build" || fs.existsSync(archive(task)));

interface Outcome {
  name: string;
  kind: string;
  key: string;
  status: "ran" | "cached" | "verified" | "stale" | "failed" | "skipped" | "missing";
  seconds: number;
}
const outcomes: Outcome[] = [];

function node(args: string[], cwd = ROOT) {
  const run = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (run.error) throw run.error;
  return run.status === 0;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bobr-ci-"));
const archives = new Map<string, string>();
const tool = (name: string) => path.join(import.meta.dirname, name);

function execute(task: Task): boolean {
  const dir = path.join(ROOT, task.dir);
  switch (task.kind) {
    case "build": {
      // Write next to the cache entry, then rename, so a failed build stores nothing.
      const file = values.fresh ? path.join(temp, `${task.key}.tar`) : archive(task);
      const partial = `${file}.partial`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!node([tool("build-app.ts"), dir, partial, values.target!])) return false;
      fs.renameSync(partial, file);
      archives.set(task.name, file);
      return true;
    }
    case "browser":
      return node([tool("run-playwright.ts"), archives.get(task.needs!)!, path.join(dir, task.file!)]);
    case "typecheck":
      return node([tool("typecheck.ts"), dir]);
    case "lint":
      return node([tool("lint.ts"), dir]);
    case "unit": {
      const bundle = path.join(temp, `${task.key}.cjs`);
      return node([tool("bundle-test.ts"), path.join(dir, task.file!), bundle]) && node([bundle], dir);
    }
  }
}

// Builds run first, since browser tests need their archives.
const order = [...selected].sort((a, b) => Number(b.kind === "build") - Number(a.kind === "build"));
for (const task of order) {
  const begin = Date.now();
  const outcome = (status: Outcome["status"]) =>
    outcomes.push({ name: task.name, kind: task.kind, key: task.key, status, seconds: (Date.now() - begin) / 1000 });
  if (values.plan) {
    outcome(stored(task) ? "cached" : "missing");
    continue;
  }
  if (stored(task)) {
    // A read refreshes the entry's time, so trimming keeps what runs still use.
    const now = new Date();
    fs.utimesSync(result(task), now, now);
    if (task.kind === "build") {
      fs.utimesSync(archive(task), now, now);
      archives.set(task.name, archive(task));
      // Shadow mode. A fresh build of the same tree must match the archive
      // the key selected, or the key missed something Next reads.
      if (values.verify) {
        console.log(`\n=== ${task.name} (verify the stored archive)`);
        const fresh = path.join(temp, `${task.key}.fresh.tar`);
        const problems = node([tool("build-app.ts"), path.join(ROOT, task.dir), fresh, values.target!])
          ? compare(archive(task), fresh)
          : ["the fresh build failed"];
        if (problems.length) {
          console.error(`${task.name}: the stored archive differs from a fresh build:\n${problems.join("\n")}`);
          outcome("stale");
          continue;
        }
      }
    }
    outcome(values.verify && task.kind === "build" ? "verified" : "cached");
    continue;
  }
  if (task.needs && !archives.has(task.needs)) {
    outcome("skipped");
    continue;
  }
  console.log(`\n=== ${task.name}`);
  const ok = execute(task);
  if (ok && !values.fresh) {
    fs.mkdirSync(path.dirname(result(task)), { recursive: true });
    fs.writeFileSync(result(task), JSON.stringify({ task: task.name, at: new Date().toISOString() }) + "\n");
  }
  outcome(ok ? "ran" : "failed");
}

if (values.out) {
  fs.mkdirSync(values.out, { recursive: true });
  for (const task of selected.filter((task) => task.kind === "build" && archives.has(task.name)))
    fs.copyFileSync(archives.get(task.name)!, path.join(values.out, `${path.basename(task.dir)}.tar`));
}
fs.rmSync(temp, { recursive: true, force: true });

const label = {
  ran: "ran",
  cached: "from cache",
  verified: "from cache, matches a fresh build",
  stale: "STALE, differs from a fresh build",
  failed: "FAILED",
  skipped: "skipped, its build failed",
  missing: "would run",
};
const table = [
  "| Task | Result | Seconds |",
  "| --- | --- | --- |",
  ...outcomes.map((o) => `| \`${o.name}\` | ${label[o.status]} | ${o.seconds.toFixed(1)} |`),
].join("\n");
const counts = (status: Outcome["status"]) => outcomes.filter((o) => o.status === status).length;
const summary = values.plan
  ? `${counts("missing")} of ${outcomes.length} tasks would run. byakugan computed the keys in ${keyed.toFixed(1)}s.`
  : `${counts("ran")} tasks ran, ${counts("cached") + counts("verified")} came from cache, ${counts("failed") + counts("stale")} failed. byakugan computed the keys in ${keyed.toFixed(1)}s.`;
console.log(`\n${table}\n\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY && !values.plan)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Tasks (${values.target})\n\n${table}\n\n${summary}\n\n`);
if (process.env.GITHUB_OUTPUT && values.plan)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `browser=${outcomes.some((o) => o.kind === "browser" && o.status === "missing")}\n`);
if (values.report) fs.writeFileSync(values.report, JSON.stringify(outcomes, null, 2) + "\n");
if (counts("failed") || counts("stale") || counts("skipped")) process.exitCode = 1;
