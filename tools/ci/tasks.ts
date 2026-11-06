// The tasks CI runs and the cache key of each. byakugan computes every key
// from the code the task reads, so an edit that no task reads changes no key.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Config } from "byakugan-cli";

export const ROOT = path.resolve(import.meta.dirname, "../..");

export type Kind = "build" | "browser" | "typecheck" | "lint" | "unit";

export interface Task {
  /** `build:web`, `browser:web`, `unit:ui/src/utils/add/index.test.ts`. */
  name: string;
  kind: Kind;
  key: string;
  /** The package directory, relative to the root. */
  dir: string;
  /** The test file of a unit task, the Playwright config of a browser task. */
  file?: string;
  /** The build task whose archive a browser task tests. */
  needs?: string;
}

const BYAKUGAN = JSON.parse(
  fs.readFileSync(path.join(ROOT, "node_modules/byakugan-cli/package.json"), "utf8"),
).version as string;
// Build outputs and test results depend on the machine as well as the code.
const MACHINE = `${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`;

// The scripts that run each kind of task. An edit to one reruns its tasks.
const TOOLS: Record<Kind, string[]> = {
  build: ["tools/ci/build-app.ts", "tools/ci/check-artifact.ts"],
  browser: ["tools/ci/run-playwright.ts", "tools/ci/artifact-server.ts", "tools/ci/check-artifact.ts"],
  typecheck: ["tools/ci/typecheck.ts"],
  lint: ["tools/ci/lint.ts"],
  unit: ["tools/ci/bundle-test.ts"],
};

// Next writes next-env.d.ts during a build. byakugan leaves it out of
// `inputs`, and the code files a type check reads leave it out too, so a
// build does not change the type check's key.
const GENERATED = new Set(["node_modules", ".next", ".vercel", "next-env.d.ts"]);
const codeFiles = (dir: string) =>
  fs.globSync("**/*.{ts,tsx,mts,cts}", { cwd: path.join(ROOT, dir), exclude: (name) => GENERATED.has(path.basename(name)) }).sort();

function sha(...parts: string[]) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(part + "\0");
  return hash.digest("hex");
}

function files(names: string[]) {
  return sha(...names.map((name) => name + "\0" + sha(fs.readFileSync(path.join(ROOT, name), "latin1"))));
}

export const warnings: string[] = [];

// Each fingerprint parses its own graph, so they run on worker threads.
const requests: {
  dir: string;
  config?: Config;
  quiet: boolean;
  resolve: (fingerprint: string) => void;
  reject: (error: Error) => void;
}[] = [];

/** byakugan's fingerprint of the code reached from `dir` with `config`. */
function fingerprint(dir: string, config?: Config, quiet = false) {
  return new Promise<string>((resolve, reject) => requests.push({ dir, config, quiet, resolve, reject }));
}

async function computeFingerprints() {
  const queue = [...requests];
  requests.length = 0;
  const worker = async () => {
    const thread = new Worker(path.join(import.meta.dirname, "fingerprint-worker.ts"));
    try {
      for (let request = queue.shift(); request; request = queue.shift()) {
        const { dir, config, quiet, resolve, reject } = request;
        const answer = await new Promise<{ fingerprint?: string; warnings?: string[]; error?: string }>((done, fail) => {
          thread.once("message", done);
          thread.once("error", fail);
          thread.postMessage({ cwd: path.join(ROOT, dir), config });
        });
        thread.removeAllListeners("error");
        if (!quiet) for (const warning of answer.warnings ?? []) warnings.push(`${dir}: ${warning}`);
        if (answer.fingerprint) resolve(answer.fingerprint);
        else reject(new Error(`byakugan failed in ${dir}: ${answer.error}`));
      }
    } finally {
      await thread.terminate();
    }
  };
  const threads = Math.max(1, Math.min(queue.length, os.availableParallelism() - 1));
  await Promise.all(Array.from({ length: threads }, worker));
}

async function key(kind: Kind, ...parts: (string | Promise<string>)[]) {
  return sha(kind, MACHINE, BYAKUGAN, files(TOOLS[kind]), ...(await Promise.all(parts)));
}

interface Package {
  dir: string;
  name: string;
  manifest: { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
}

/** The workspace packages that pnpm-workspace.yaml lists. */
function packages(): Package[] {
  const yaml = fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const list = yaml.split(/^packages:\n/m)[1]!.split(/^\S/m)[0]!;
  const globs = [...list.matchAll(/^\s+-\s+["']?([^"'\n]+)["']?$/gm)].map((match) => match[1]!);
  return globs
    .flatMap((glob) => fs.globSync(glob, { cwd: ROOT }))
    .filter((dir) => fs.existsSync(path.join(ROOT, dir, "package.json")))
    .sort()
    .map((dir) => ({
      dir,
      name: path.basename(dir),
      manifest: JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8")),
    }));
}

const dependencies = (pkg: Package) => ({ ...pkg.manifest.devDependencies, ...pkg.manifest.dependencies });
const has = (pkg: Package, pattern: string) => fs.globSync(pattern, { cwd: path.join(ROOT, pkg.dir) }).length > 0;

type Pending = Omit<Task, "key"> & { key: Promise<string> };

export async function tasks(target: string): Promise<Task[]> {
  const all = packages();
  const out: Pending[] = [];
  const builds = new Map<string, Pending>();
  const isApp = (pkg: Package) => "next" in dependencies(pkg) && has(pkg, "next.config.*");
  const isSuite = (pkg: Package) => "@playwright/test" in dependencies(pkg);

  for (const pkg of all.filter(isApp)) {
    // The app's byakugan.json adds the Vercel settings and CLI to its graph.
    const build: Pending = { name: `build:${pkg.name}`, kind: "build", dir: pkg.dir, key: key("build", target, fingerprint(pkg.dir)) };
    builds.set(pkg.manifest.name, build);
    out.push(build);
  }
  for (const pkg of all) {
    if (isSuite(pkg)) {
      // A browser suite tests the archive of the workspace app it depends on.
      for (const dependency of Object.keys(dependencies(pkg))) {
        const build = builds.get(dependency);
        if (!build) continue;
        const suite = fingerprint(pkg.dir, { framework: "none", entry: ["playwright.config.ts", "src/**/*.test.ts"] });
        out.push({
          name: `browser:${path.basename(build.dir)}`,
          kind: "browser",
          dir: pkg.dir,
          file: "playwright.config.ts",
          needs: build.name,
          key: key("browser", build.key, suite),
        });
      }
      continue;
    }
    // tsc reads every file its tsconfig includes, reached or not, so every
    // code file is an entry. The graph adds the shared code those files reach.
    if (has(pkg, "tsconfig.json"))
      out.push({ name: `typecheck:${pkg.name}`, kind: "typecheck", dir: pkg.dir, key: key("typecheck", fingerprint(pkg.dir, { entry: codeFiles(pkg.dir) })) });
    // ESLint reads the package's own files and its config, never the code
    // those files import.
    const [eslintConfig] = fs.globSync("eslint.config.{js,mjs,cjs}", { cwd: path.join(ROOT, pkg.dir) });
    if (eslintConfig)
      out.push({
        name: `lint:${pkg.name}`,
        kind: "lint",
        dir: pkg.dir,
        key: key("lint", fingerprint(pkg.dir, { framework: "none", entry: [eslintConfig], inputs: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], packages: ["eslint"] })),
      });
    // Each test file is its own task, keyed on the code it reaches.
    const tests = fs.globSync("**/*.test.{ts,tsx}", {
      cwd: path.join(ROOT, pkg.dir),
      exclude: (name) => path.basename(name) === "node_modules",
    });
    for (const test of tests.sort())
      out.push({
        name: `unit:${pkg.name}/${test}`,
        kind: "unit",
        dir: pkg.dir,
        file: test,
        key: key("unit", fingerprint(pkg.dir, { framework: "none", entry: [test] })),
      });
  }
  // The CI scripts check against one tsconfig. They read files at runtime,
  // which byakugan warns about, but a type check does not run them.
  out.push({
    name: "typecheck:tools",
    kind: "typecheck",
    dir: "tools/ci",
    key: key(
      "typecheck",
      fingerprint("tools/ci", { framework: "none", entry: ["*.ts"] }, true),
      fingerprint("scripts", { framework: "none", entry: ["*.ts"] }, true),
    ),
  });
  const keys = Promise.all(out.map((task) => task.key));
  await computeFingerprints();
  return (await keys).map((key, i) => ({ ...out[i]!, key }));
}
