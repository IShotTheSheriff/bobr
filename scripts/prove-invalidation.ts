// Proves that edits rerun only the tasks that read them, in a disposable copy
// of the working tree. After every edit it also builds each app that CI
// reused and compares that build with the stored archive. A difference means
// byakugan missed something Next reads, and the proof fails.
//
//   node scripts/prove-invalidation.ts [--browser] [--keys-only] [--directory DIR]
//
// --browser     Also run the Playwright suites. Without it, they are left out.
// --keys-only   Compare cache keys only. Builds nothing and runs no checks.
// --directory   New directory for the copy, the cache and the evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import * as tar from "tar";
import { compare } from "../tools/ci/compare-archives.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    browser: { type: "boolean" },
    "keys-only": { type: "boolean" },
    directory: { type: "string" },
  },
});
const keysOnly = values["keys-only"];
const base = values.directory
  ? path.resolve(values.directory)
  : fs.mkdtempSync(path.join(os.tmpdir(), "bobr-proof-"));
fs.mkdirSync(base, { recursive: true });
if (fs.readdirSync(base).length) throw new Error(`${base} is not empty`);
const cache = path.join(base, "cache");
let checkout = path.join(base, "source");
console.log(`Evidence: ${base}`);

function run(command: string, args: string[], log: string, cwd = checkout) {
  const output = fs.openSync(path.join(base, log), "a");
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", output, output] });
  fs.closeSync(output);
  if (result.error) throw result.error;
  return result.status === 0;
}

function must(command: string, args: string[], log: string, cwd = checkout) {
  if (!run(command, args, log, cwd)) {
    const text = fs.readFileSync(path.join(base, log), "utf8");
    throw new Error(`${command} ${args.join(" ")} failed. See ${path.join(base, log)}\n${text.slice(-6000)}`);
  }
}

const git = (...args: string[]) =>
  must("git", ["-c", "user.name=proof", "-c", "user.email=proof@localhost", "-c", "commit.gpgsign=false", ...args], "git.log");

// The copy holds the tracked files and new files git does not ignore.
const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.error ?? listed.stderr}`);
for (const name of new Set(listed.stdout.split("\0"))) {
  const source = path.join(ROOT, name);
  if (!name || !fs.existsSync(source) || !fs.lstatSync(source).isFile()) continue;
  fs.mkdirSync(path.dirname(path.join(checkout, name)), { recursive: true });
  fs.copyFileSync(source, path.join(checkout, name));
}
git("init", "-q");
must("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], "install.log");

const file = (name: string) => path.join(checkout, name);
const read = (name: string) => fs.readFileSync(file(name), "utf8");
function write(name: string, text: string) {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true });
  fs.writeFileSync(file(name), text);
}
function edit(name: string, from: string, to: string) {
  const text = read(name);
  if (!text.includes(from)) throw new Error(`${name} no longer contains ${JSON.stringify(from)}. Update the proof.`);
  write(name, text.replace(from, to));
}

interface Outcome {
  name: string;
  key: string;
  status: string;
}

const seen = new Set<string>();
const previousArchives = new Map<string, string>();
const results: unknown[] = [];

function archiveOf(outcome: Outcome) {
  return path.join(cache, "archives", `${outcome.key}.tar`);
}

// The JavaScript the archive ships to browsers.
function clientScripts(archive: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobr-proof-archive-"));
  tar.x({ file: archive, cwd: dir, sync: true });
  const scripts = fs
    .globSync("static/_next/static/chunks/**/*.js", { cwd: dir })
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"));
  fs.rmSync(dir, { recursive: true });
  return scripts;
}

function step(name: string, expected: string[], options: { allCached?: boolean } = {}) {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", name);
  const report = path.join(base, `${name}.json`);
  const args = ["tools/ci/run.ts", "test", "--cache", cache, "--report", report];
  if (!values.browser) args.push("--skip", "browser");
  if (keysOnly) args.push("--plan");
  must(process.execPath, args, `${name}.log`);
  const outcomes: Outcome[] = JSON.parse(fs.readFileSync(report, "utf8"));
  const wanted = new Set(expected.filter((task) => values.browser || !task.startsWith("browser:")));
  // A task runs when no earlier step stored a result under its key.
  const executed = new Set(outcomes.filter((o) => !seen.has(o.key)).map((o) => o.name));
  for (const o of outcomes) seen.add(o.key);
  const extra = [...executed].filter((task) => !wanted.has(task));
  const missing = [...wanted].filter((task) => !executed.has(task));
  if (extra.length || missing.length)
    throw new Error(`${name}: ran ${[...executed].sort().join(", ") || "nothing"}\n  unexpected: ${extra.join(", ") || "none"}\n  expected but skipped: ${missing.join(", ") || "none"}`);
  if (!keysOnly) {
    // The runner's own view must match: it reran exactly these tasks.
    const ran = outcomes.filter((o) => o.status === "ran").map((o) => o.name);
    if (ran.sort().join() !== [...executed].sort().join()) throw new Error(`${name}: the runner ran ${ran.join(", ")}`);
    if (options.allCached && outcomes.some((o) => o.status !== "cached")) throw new Error(`${name}: expected every task from cache`);
  }
  const evidence: Record<string, string> = {};
  if (!keysOnly) {
    for (const build of outcomes.filter((o) => o.name.startsWith("build:"))) {
      const app = build.name.slice("build:".length);
      const stored = archiveOf(build);
      if (build.status === "cached") {
        // The oracle. CI reused this archive, so a fresh build of the edited
        // tree must match it.
        const fresh = path.join(base, "fresh", name);
        must(process.execPath, ["tools/ci/run.ts", "build", "--only", build.name, "--fresh", "--out", fresh], `${name}.oracle.log`);
        const problems = compare(stored, path.join(fresh, `${app}.tar`));
        if (problems.length) throw new Error(`${name}: CI reused a stale ${app} build\n${problems.join("\n")}`);
        evidence[app] = "reused, and a fresh build matches";
      } else {
        const before = previousArchives.get(app);
        const same = before && compare(before, stored).length === 0;
        evidence[app] = same ? "rebuilt, output unchanged" : "rebuilt, output changed";
      }
      previousArchives.set(app, stored);
    }
  }
  results.push({ case: name, ran: [...executed].sort(), builds: evidence });
  fs.writeFileSync(path.join(base, "results.json"), JSON.stringify(results, null, 2) + "\n");
  const builds = Object.entries(evidence).map(([app, text]) => `${app} ${text}`).join("; ");
  console.log(`PASS ${name}: ran ${[...executed].sort().join(", ") || "nothing"}${builds ? `. ${builds}` : ""}`);
}

const ui = ["typecheck:ui", "lint:ui"];
const addTest = ["unit:ui/src/utils/add/index.test.ts"];
const subTest = ["unit:ui/src/utils/sub/index.test.ts"];
const web = ["build:web", "browser:web", "typecheck:web"];
const docs = ["build:docs", "browser:docs", "typecheck:docs"];
const webTest = ["unit:web/lib/calculator.test.ts"];
const docsTest = ["unit:docs/lib/calculator.test.ts"];
const tools = ["typecheck:tools"];
const everything = [...ui, ...addTest, ...subTest, ...web, ...docs, ...webTest, ...docsTest, "lint:web", "lint:docs"];

// An unused branch of the utility barrel. No app imports it.
write("packages/ui/src/utils/unused.ts", "export const unused = () => 101;\n");
edit("packages/ui/src/utils/index.ts", 'export { sub } from "./sub";', 'export { sub } from "./sub";\nexport { unused } from "./unused";');
step("baseline", [...everything, ...tools]);
step("no-op", []);

write("packages/ui/src/unreachable.tsx", 'import { unused } from "./utils";\nexport const Widget = () => unused();\n');
step("add-unreachable-component", ui);
write("packages/ui/src/unreachable.tsx", 'import { unused } from "./utils";\n(globalThis as Record<string, unknown>).bobrUnreachable = 42;\nexport const Widget = () => unused() + 1;\n');
step("change-unreachable-component", ui);
write("packages/ui/src/utils/unused.ts", "export const unused = () => 202;\n");
step("unused-barrel-export", ui);
edit("packages/ui/src/utils/add/index.ts", "};", "};\n\nexport const unusedSibling = () => 303;");
step("unused-export-in-used-module", ui);
edit("packages/ui/src/code.tsx", "export function Code", "export const CodeLabel = () => <span>code</span>;\n\nexport function Code");
step("unused-export-in-used-component", ui);

// A used export changes what the app shows, so the tests change with it.
edit("packages/ui/src/utils/add/index.ts", "a + 12", "a + 13");
edit("packages/ui/src/utils/add/index.test.ts", "add(8), 20", "add(8), 21");
edit("packages/ui/src/utils/add/index.test.ts", "add(0), 12", "add(0), 13");
edit("apps/web/lib/calculator.test.ts", "calculate(50), 62", "calculate(50), 63");
edit("packages/web-e2e/src/index.test.ts", '"63"', '"64"');
edit("packages/web-e2e/src/index.test.ts", '"62"', '"63"');
step("used-add", [...ui, ...addTest, ...web, ...webTest, "lint:web"]);
edit("packages/ui/src/utils/sub/index.ts", "a - 5", "a - 6");
edit("packages/ui/src/utils/sub/index.test.ts", "sub(8), 3", "sub(8), 2");
edit("packages/ui/src/utils/sub/index.test.ts", "sub(0), -5", "sub(0), -6");
edit("apps/docs/lib/calculator.test.ts", "45,", "44,");
edit("apps/docs/lib/calculator.test.ts", "shows 45", "shows 44");
edit("packages/docs-e2e/src/index.test.ts", '"45"', '"44"');
edit("packages/docs-e2e/src/index.test.ts", '"46"', '"45"');
step("used-sub", [...ui, ...subTest, ...docs, ...docsTest, "lint:docs"]);

// A comment inside a used function. byakugan leaves comments out of its
// hashes, so only the lint of @repo/ui reruns, since ESLint reads whole files.
// The oracle checks that the reused web build matches a fresh one.
edit("packages/ui/src/utils/add/index.ts", "return a + 13;", "// The offset the home page shows.\n  return a + 13;");
step("comment-in-used-function", ["lint:ui"]);

// @repo/ui declares sideEffects false, so Turbopack drops a module whose
// exports nobody uses, effects included. byakugan skips it too, and the
// oracle shows that Next agrees.
write("packages/ui/src/utils/unused.ts", '(globalThis as Record<string, unknown>).bobrSideEffect = "effect-one";\nexport const unused = () => 202;\n');
step("side-effect-in-unused-branch", ui);
// An effect in a module an app uses reaches that app's bundle.
write("packages/ui/src/utils/add/index.ts", read("packages/ui/src/utils/add/index.ts") + '\n(globalThis as Record<string, unknown>).bobrUsedEffect = "effect-one";\n');
step("side-effect-in-used-module", [...ui, ...addTest, ...web, ...webTest]);
edit("packages/ui/src/utils/add/index.ts", '"effect-one"', '"effect-two"');
step("changed-side-effect", [...ui, ...addTest, ...web, ...webTest]);
if (!keysOnly) {
  const webBuild = (JSON.parse(fs.readFileSync(path.join(base, "changed-side-effect.json"), "utf8")) as Outcome[]).find((o) => o.name === "build:web")!;
  if (!clientScripts(archiveOf(webBuild)).some((text) => text.includes("effect-two"))) throw new Error("web: Next dropped the side effect");
}

// The rows of the README's table that edits outside @repo/ui cover.
write("apps/web/components/banner.tsx", "export const Banner = () => <p>Built from the projection</p>;\n");
edit("apps/web/app/page.tsx", 'import Image from "next/image";', 'import Image from "next/image";\nimport { Banner } from "../components/banner";');
edit("apps/web/app/page.tsx", '<div className="absolute inset-0 z-0">', '<Banner />\n      <div className="absolute inset-0 z-0">');
step("new-folder-and-component-in-web", [...web, "lint:web"]);
edit("apps/web/README.md", "#", "# Notes\n\n#");
step("app-readme", []);
edit("packages/eslint-config/base.js", "js.configs.recommended,", 'js.configs.recommended,\n  { rules: { "no-debugger": "error" } },');
step("shared-eslint-rule", ["lint:web", "lint:docs", "lint:ui"]);
const docsManifest = JSON.parse(read("apps/docs/package.json"));
docsManifest.dependencies.clsx = "2.1.1";
write("apps/docs/package.json", JSON.stringify(docsManifest, null, 2) + "\n");
must("pnpm", ["install", "--prefer-offline"], "install.log");
edit("apps/docs/app/page.tsx", 'import { calculate } from "../lib/calculator";', 'import { calculate } from "../lib/calculator";\nimport { clsx } from "clsx";');
edit("apps/docs/app/page.tsx", 'items-center justify-center relative">', 'items-center justify-center relative">\n      <div className={clsx("docs")} />');
step("new-npm-dependency-in-docs", [...docs, "lint:docs"]);
edit("packages/typescript-config/base.json", '"strict": true', '"strict": true,\n    "noImplicitOverride": true');
step("shared-tsconfig", everything);

// Consume the utilities only through a component's bare relative import.
for (const [name, body] of [["add", "a + b + 13"], ["sub", "a - b - 6"]])
  write(`packages/ui/src/proof-${name}.tsx`, `import /* comment */ "./utils";\nexport const ${name} = (a: number, b: number = 0) => ${body};\n`);
for (const app of ["web", "docs"]) {
  const generated = (name: string) => ["node_modules", ".next"].includes(path.basename(name));
  for (const name of fs.globSync(`apps/${app}/**/*.{ts,tsx}`, { cwd: checkout, exclude: generated })) {
    let text = read(name);
    for (const util of ["add", "sub"])
      text = text.replace(`import { ${util} } from "@repo/ui/utils"`, `import { ${util} } from "@repo/ui/proof-${util}"`);
    if (text.includes('from "@repo/ui/utils"')) throw new Error(`${name}: update the proof's import rewrite`);
    write(name, text);
  }
}
step("relative-side-effect-import", [...ui, ...web, ...docs, ...webTest, ...docsTest, "lint:web", "lint:docs"]);
// Under sideEffects false, a bare import of a module whose exports nobody
// uses is dropped, so its effects never run.
edit("packages/ui/src/utils/unused.ts", "effect-one", "relative-effect-three");
step("unused-effect-behind-relative-import", ui);
// Without the flag, every module counts as having effects, so the bare
// import keeps the barrel and the unused module.
const uiManifest = JSON.parse(read("packages/ui/package.json"));
delete uiManifest.sideEffects;
write("packages/ui/package.json", JSON.stringify(uiManifest, null, 2) + "\n");
step("package-without-side-effects-flag", [...ui, ...addTest, ...subTest, ...web, ...docs, ...webTest, ...docsTest]);
edit("packages/ui/src/utils/unused.ts", "relative-effect-three", "relative-effect-four");
step("changed-relative-side-effect", [...ui, ...web, ...docs, ...webTest, ...docsTest]);
if (!keysOnly) {
  const builds = (JSON.parse(fs.readFileSync(path.join(base, "changed-relative-side-effect.json"), "utf8")) as Outcome[]).filter((o) => o.name.startsWith("build:"));
  for (const build of builds)
    if (!clientScripts(archiveOf(build)).some((text) => text.includes("relative-effect-four"))) throw new Error(`${build.name}: Next dropped the relative import's side effect`);
}

// A second clone at another path, sharing only the cache, reuses everything.
git("add", "-A");
git("commit", "-q", "--allow-empty", "-m", "before the fresh clone");
must("git", ["clone", "-q", checkout, path.join(base, "clone")], "git.log", base);
checkout = path.join(base, "clone");
must("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], "install.log");
step("fresh-clone", [], { allCached: true });

console.log(`All cases passed. Evidence: ${path.join(base, "results.json")}`);
