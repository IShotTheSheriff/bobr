// Each precision claim has two halves: an edit the app cannot reach leaves the
// projection byte-identical, and an edit it can reach changes it. Runtime
// cases also bundle the app against the projection and against the whole
// packages and compare what the bundles do, as the equivalence check does
// for real Next builds.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import esbuild from "esbuild";
import linkProjection from "./link-projection.ts";
import project, { nextEntries, packageArgument, type Manifest, type Mode, type Report } from "./projection.ts";

type Files = Record<string, string>;

const UI = {
  name: "@repo/ui",
  sideEffects: false,
  exports: {
    ".": "./src/index.ts",
    "./utils": "./src/utils/index.ts",
    "./utils/*": "./src/utils/*/index.ts",
    "./*": "./src/*.tsx",
  },
};

const APP = { name: "web", dependencies: { "@repo/ui": "workspace:*" } };

function write(root: string, files: Files) {
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

function list(dir: string, prefix = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name), prefix + e.name + "/") : [prefix + e.name]))
    .sort();
}

interface Run {
  report: Report;
  out: string;
  /** Projected files of a package, relative to its directory. */
  files(dir?: string): string[];
  read(file: string): string | undefined;
  /** Every projected file and its text, for byte comparisons. */
  snapshot(): string;
}

let evaluations = 0;

/** A pnpm workspace in a temporary directory: apps/web and packages/*. */
function workspace(t: TestContext, files: Files, { ui = UI, app = APP }: { ui?: object; app?: object } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "projection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, {
    "apps/web/package.json": JSON.stringify(app),
    "packages/ui/package.json": JSON.stringify(ui),
    ...files,
  });

  function run(mode: Mode = "runtime", options: { strict?: boolean } = {}): Run {
    const out = path.join(root, "out", mode);
    const packages = fs
      .readdirSync(path.join(root, "packages"))
      .filter((dir) => fs.existsSync(path.join(root, "packages", dir, "package.json")))
      .map((dir) => {
        const json = JSON.parse(fs.readFileSync(path.join(root, "packages", dir, "package.json"), "utf8"));
        return packageArgument(`${json.name}=${path.join(root, "packages", dir)}=packages/${dir}`);
      });
    const report = project({ mode, app: path.join(root, "apps/web"), packages, out, root, ...options });
    return {
      report,
      out,
      files: (dir = "packages/ui") => list(path.join(out, dir)),
      read: (file) => (fs.existsSync(path.join(out, file)) ? fs.readFileSync(path.join(out, file), "utf8") : undefined),
      snapshot: () =>
        list(out)
          .map((file) => `== ${file}\n${fs.readFileSync(path.join(out, file), "utf8")}`)
          .join("\n"),
    };
  }

  /**
   * Bundles the app's entry against a projection, the way the Next build
   * links it, runs the bundle and returns its exports and the log that module
   * effects push to.
   */
  async function evaluate(mode: Mode, entry = "app/page.tsx") {
    const { out } = run(mode);
    const target = path.join(root, "eval", `${mode}-${++evaluations}`);
    fs.cpSync(path.join(root, "apps/web"), path.join(target, "apps/web"), { recursive: true });
    linkProjection(out, target, "apps/web");
    const result = await esbuild.build({
      entryPoints: [path.join(target, "apps/web", entry)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      logLevel: "silent",
    });
    const log: string[] = [];
    (globalThis as { __log?: string[] }).__log = log;
    t.after(() => delete (globalThis as { __log?: string[] }).__log);
    const code = `${result.outputFiles[0]!.text}\n// ${evaluations}`;
    const exports = { ...(await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) };
    return { exports, log };
  }

  /** The app behaves the same against the projection as against whole packages. */
  async function equivalent(entry?: string) {
    const projected = await evaluate("runtime", entry);
    const whole = await evaluate("copy", entry);
    assert.deepEqual(projected, whole);
    return projected;
  }

  return { root, write: (more: Files) => write(root, more), run, evaluate, equivalent };
}

const page = (code: string) => ({ "apps/web/app/page.tsx": code });

// ---------------------------------------------------------------------------
// Resolution

test("export maps: conditions are a union, wildcards expand and null hides a path", (t) => {
  const w = workspace(
    t,
    {
      ...page('import { a } from "@repo/ui/feature/a"; import "@repo/ui/feature/private/x"; export const result = a;'),
      "packages/ui/src/feature/a.ts": "export const a = 1;",
      "packages/ui/src/feature/a.server.ts": "export const a = 2;",
      "packages/ui/src/feature/b.ts": "export const b = 1;",
      "packages/ui/src/feature/private/x.ts": "export const x = 1;",
    },
    {
      ui: {
        name: "@repo/ui",
        exports: {
          "./feature/private/*": null,
          "./feature/*": { "react-server": "./src/feature/*.server.ts", default: ["./src/feature/*.ts"] },
        },
      },
    },
  );
  const run = w.run();
  assert.deepEqual(run.files(), ["package.json", "src/feature/a.server.ts", "src/feature/a.ts"]);
  assert.deepEqual(run.report.unresolved, [{ file: "apps/web/app/page.tsx", specifier: "@repo/ui/feature/private/x" }]);
  assert.throws(() => w.run("runtime", { strict: true }), /cannot resolve @repo\/ui\/feature\/private\/x/);
});

test("package imports, tsconfig paths and .js specifiers resolve to source files", (t) => {
  const w = workspace(
    t,
    {
      ...page('import { calc } from "@/lib/calc"; export const result = calc();'),
      "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
      "apps/web/lib/calc.ts": 'import { helper, add } from "@repo/ui/utils"; export const calc = () => helper() + add(1);',
      "packages/ui/src/utils/index.ts": 'export { helper } from "#lib/helper"; export { add } from "./add/index.js";',
      "packages/ui/src/lib/helper.ts": "export const helper = () => 1;",
      "packages/ui/src/lib/unused.ts": "export const unused = () => 1;",
      "packages/ui/src/utils/add/index.ts": "export const add = (a: number) => a + 1;",
    },
    { ui: { ...UI, imports: { "#lib/*": "./src/lib/*.ts" } } },
  );
  const run = w.run();
  assert.deepEqual(run.files(), ["package.json", "src/lib/helper.ts", "src/utils/add/index.ts", "src/utils/index.ts"]);
  assert.deepEqual(run.report.unresolved, []);
});

test("package.json scripts and devDependencies stay out; fields resolvers read stay in", (t) => {
  const files = { ...page('import { a } from "@repo/ui/utils"; export const r = a;'), "packages/ui/src/utils/index.ts": "export const a = 1;" };
  const w = workspace(t, files, { ui: { ...UI, scripts: { lint: "eslint ." }, devDependencies: { eslint: "9.0.0" } } });
  const snapshot = w.run().snapshot();
  assert.doesNotMatch(snapshot, /eslint/);
  w.write({ "packages/ui/package.json": JSON.stringify({ ...UI, scripts: { lint: "eslint --fix ." }, devDependencies: { eslint: "9.1.0" } }) });
  assert.equal(w.run().snapshot(), snapshot);
  w.write({ "packages/ui/package.json": JSON.stringify({ ...UI, sideEffects: true }) });
  assert.notEqual(w.run().snapshot(), snapshot);
  // The equivalence check's copy keeps the file as it is.
  assert.match(w.run("copy").read("packages/ui/package.json")!, /"sideEffects":true/);
});

// ---------------------------------------------------------------------------
// Whole files and slices

test("a component file is copied whole, and components no app imports stay out", (t) => {
  const button = '"use client";\nexport const Button = () => <button />;\nexport const Unused = () => <a />;\n';
  const w = workspace(t, {
    ...page('import { Button } from "@repo/ui/button"; export default Button;'),
    "packages/ui/src/button.tsx": button,
    "packages/ui/src/card.tsx": "export const Card = () => <div />;",
  });
  const before = w.run();
  assert.equal(before.read("packages/ui/src/button.tsx"), button);
  assert.deepEqual(before.files(), ["package.json", "src/button.tsx"]);
  const snapshot = before.snapshot();

  w.write({ "packages/ui/src/card.tsx": "export const Card = () => <section />;" });
  assert.equal(w.run().snapshot(), snapshot);
  w.write({ "packages/ui/src/button.tsx": button.replace("<a />", "<b />") });
  assert.notEqual(w.run().snapshot(), snapshot);
});

test("a utility module keeps only what the used exports reach", (t) => {
  const w = workspace(t, {
    ...page('import { add } from "@repo/ui/utils/math"; export const result = add(1);'),
    "packages/ui/src/utils/math/index.ts":
      "const step = 1;\nexport const add = (a: number) => a + step;\nexport const sub = (a: number) => a - 1;\n",
  });
  const run = w.run();
  const text = run.read("packages/ui/src/utils/math/index.ts")!;
  assert.match(text, /const step = 1/);
  assert.match(text, /export const add/);
  assert.doesNotMatch(text, /sub/);
  const snapshot = run.snapshot();

  w.write({
    "packages/ui/src/utils/math/index.ts":
      "const step = 1;\nexport const add = (a: number) => a + step;\nexport const sub = (a: number) => a - 2;\n",
  });
  assert.equal(w.run().snapshot(), snapshot);
  w.write({
    "packages/ui/src/utils/math/index.ts":
      "const step = 2;\nexport const add = (a: number) => a + step;\nexport const sub = (a: number) => a - 2;\n",
  });
  assert.notEqual(w.run().snapshot(), snapshot);
});

test("comments and formatting in a used function leave the projection unchanged", async (t) => {
  const source = (body: string) => ({
    ...page('import { add, load } from "@repo/ui/utils/math"; export const result = [add(1), typeof load];'),
    "packages/ui/src/utils/math/index.ts": body,
  });
  const w = workspace(
    t,
    source(
      "/** Adds one. */\nexport const add = (a: number) => {\n  return a + 1;\n};\n" +
        'export const load = () => import(/* webpackChunkName: "x" */ "./x");\n',
    ),
  );
  w.write({ "packages/ui/src/utils/math/x.ts": "export default 1;" });
  const run = w.run();
  // Comments that steer the bundler stay.
  assert.match(run.read("packages/ui/src/utils/math/index.ts")!, /webpackChunkName: "x"/);
  const snapshot = run.snapshot();

  w.write(
    source(
      "/** Adds one to a. */\nexport const add = (a: number) => {\n    // the step\n    return a +   1; // done\n};\n" +
        'export const load = () => import(/* webpackChunkName: "x" */ "./x");\n',
    ),
  );
  assert.equal(w.run().snapshot(), snapshot);
  w.write(source('export const add = (a: number) => {\n  return a + 2;\n};\nexport const load = () => import(/* webpackChunkName: "x" */ "./x");\n'));
  assert.notEqual(w.run().snapshot(), snapshot);
  await w.equivalent();
});

test(".tsx utilities without JSX are sliced; directives keep a file whole", (t) => {
  const client = '"use client";\nexport const a = 1;\nexport const b = 2;\n';
  const server = "export async function a() {\n  \"use server\";\n  return 1;\n}\nexport const b = 2;\n";
  const w = workspace(t, {
    ...page(
      'import { a as x } from "@repo/ui/format"; import { a as y } from "@repo/ui/client"; import { a as z } from "@repo/ui/server"; export const r = [x, y, z];',
    ),
    "packages/ui/src/format.tsx": "export const a = 1;\nexport const b = 2;\n",
    "packages/ui/src/client.tsx": client,
    "packages/ui/src/server.tsx": server,
  });
  const run = w.run();
  assert.doesNotMatch(run.read("packages/ui/src/format.tsx")!, /b = 2/);
  assert.equal(run.read("packages/ui/src/client.tsx"), client);
  assert.equal(run.read("packages/ui/src/server.tsx"), server);
});

test("npm imports in utilities stay, and the app behaves the same", async (t) => {
  const w = workspace(t, {
    ...page('import { cn } from "@repo/ui/utils"; export const result = cn("a", "b");'),
    "node_modules/clsx/package.json": JSON.stringify({ name: "clsx", type: "module", main: "index.js" }),
    "node_modules/clsx/index.js": "export default (...values) => values.join(' ');",
    "node_modules/merge/package.json": JSON.stringify({ name: "merge", type: "module", main: "index.js" }),
    "node_modules/merge/index.js": "globalThis.__log?.push('merge'); export const merge = (v) => v;",
    "packages/ui/src/utils/index.ts":
      'import clsx from "clsx";\nimport { merge } from "merge";\nexport const cn = (...values: string[]) => clsx(...values);\nexport const tidy = (v: string) => merge(v);\n',
  });
  const run = w.run();
  const text = run.read("packages/ui/src/utils/index.ts")!;
  assert.match(text, /import clsx from "clsx"/);
  // An npm package may run code on import, so its import stays without the binding.
  assert.match(text, /import "merge"/);
  assert.doesNotMatch(text, /tidy/);
  const result = await w.equivalent();
  assert.deepEqual(result, { exports: { result: "a b" }, log: ["merge"] });
});

// ---------------------------------------------------------------------------
// Barrels and side effects

const barrel = {
  "packages/ui/src/index.ts": 'export * from "./utils";\nexport { Button } from "./button";\n',
  "packages/ui/src/button.tsx": "export const Button = () => <button />;",
  "packages/ui/src/utils/index.ts": 'export * from "./add";\nexport * from "./sub";\n',
  "packages/ui/src/utils/add/index.ts": 'globalThis.__log?.push("add");\nexport const add = (a: number) => a + 1;\n',
  "packages/ui/src/utils/sub/index.ts": 'globalThis.__log?.push("sub");\nexport const sub = (a: number) => a - 1;\n',
};

test("a root import through barrels and export * reaches only the used module", async (t) => {
  const w = workspace(t, { ...page('import { add } from "@repo/ui"; export const result = add(1);'), ...barrel });
  const run = w.run();
  assert.deepEqual(run.files(), ["package.json", "src/index.ts", "src/utils/add/index.ts", "src/utils/index.ts"]);
  const snapshot = run.snapshot();
  w.write({ "packages/ui/src/utils/sub/index.ts": "export const sub = (a: number) => a - 2;" });
  assert.equal(w.run().snapshot(), snapshot);
  w.write({ "packages/ui/src/button.tsx": "export const Button = () => <a />;" });
  assert.equal(w.run().snapshot(), snapshot);
  w.write({ "packages/ui/src/utils/add/index.ts": "export const add = (a: number) => a + 2;" });
  assert.notEqual(w.run().snapshot(), snapshot);
});

test("with sideEffects false the unused module's effect is dropped, as bundlers drop it", async (t) => {
  const w = workspace(t, { ...page('import { add } from "@repo/ui"; export const result = add(1);'), ...barrel });
  assert.deepEqual(await w.equivalent(), { exports: { result: 2 }, log: ["add"] });
});

test("without sideEffects false an unused module's effect stays", async (t) => {
  const w = workspace(
    t,
    { ...page('import { add } from "@repo/ui"; export const result = add(1);'), ...barrel },
    { ui: { ...UI, sideEffects: undefined } },
  );
  assert.ok(w.run().files().includes("src/utils/sub/index.ts"));
  assert.deepEqual(await w.equivalent(), { exports: { result: 2 }, log: ["add", "sub"] });
});

// webpack matches sideEffects globs with globstar, relative to the package.
// esbuild reads them differently, so this case checks the files, not a bundle.
for (const [glob, kept] of [
  ["**/sub/*.ts", true],
  ["**/add/*.ts", false],
  ["index.ts", true],
] as const) {
  test(`sideEffects ${JSON.stringify([glob])} ${kept ? "keeps" : "drops"} the unused module`, async (t) => {
    const w = workspace(
      t,
      { ...page('import { add } from "@repo/ui"; export const result = add(1);'), ...barrel },
      { ui: { ...UI, sideEffects: [glob] } },
    );
    assert.equal(w.run().files().includes("src/utils/sub/index.ts"), kept);
    await w.equivalent();
  });
}

test("a namespace import keeps every export", async (t) => {
  const w = workspace(t, {
    ...page('import * as utils from "@repo/ui/utils"; export const result = Object.keys(utils).sort();'),
    ...barrel,
  });
  assert.ok(w.run().files().includes("src/utils/sub/index.ts"));
  assert.deepEqual((await w.equivalent()).exports, { result: ["add", "sub"] });
});

test("impure initializers stay; PURE-annotated calls and unused functions go", async (t) => {
  const w = workspace(t, {
    ...page('import { used } from "@repo/ui/utils"; export const result = used;'),
    "packages/ui/src/utils/index.ts": [
      "const record = (name: string) => globalThis.__log?.push(name);",
      "export const used = 1;",
      'export const registry = record("registry");',
      'export const lazy = /*#__PURE__*/ record("lazy");',
      "export function helper() { return 2; }",
    ].join("\n"),
  });
  const text = w.run().read("packages/ui/src/utils/index.ts")!;
  assert.match(text, /registry/);
  assert.doesNotMatch(text, /lazy|helper/);
  assert.deepEqual(await w.equivalent(), { exports: { result: 1 }, log: ["registry"] });
});

test("a component's relative side-effect import keeps the module's effect", async (t) => {
  const w = workspace(
    t,
    {
      ...page('import { Widget } from "@repo/ui/widget"; export const result = Widget();'),
      "packages/ui/src/widget.tsx": 'import "./utils";\nexport const Widget = () => (globalThis as any).__value;\n',
      "packages/ui/src/utils/index.ts": "(globalThis as any).__value = 42;\nexport const unused = 1;\n",
    },
    { ui: { ...UI, sideEffects: true } },
  );
  t.after(() => delete (globalThis as { __value?: unknown }).__value);
  assert.deepEqual((await w.equivalent()).exports, { result: 42 });
});

test("a utility that only an unreachable component uses leaves the projection alone", (t) => {
  const w = workspace(t, {
    ...page('import { used } from "@repo/ui/utils"; export const result = used;'),
    "packages/ui/src/unused-widget.tsx": 'import { unused } from "./utils";\nexport const Widget = () => unused;\n',
    "packages/ui/src/utils/index.ts": "export const used = 1;\nexport const unused = 2;\n",
  });
  const snapshot = w.run().snapshot();
  w.write({
    "packages/ui/src/unused-widget.tsx": 'throw new Error("unreachable");',
    "packages/ui/src/utils/index.ts": "export const used = 1;\nexport const unused = 3;\n",
  });
  assert.equal(w.run().snapshot(), snapshot);
});

test("comments and strings that name a module are not imports", (t) => {
  const w = workspace(t, {
    ...page('// import "@repo/ui/utils"\nexport const label = "@repo/ui/utils";'),
    "packages/ui/src/utils/index.ts": "export const used = 1;",
  });
  assert.deepEqual(w.run().files(), ["package.json"]);
});

// ---------------------------------------------------------------------------
// Assets, styles and computed imports

test("styles follow @import, url() and composes", (t) => {
  const w = workspace(t, {
    ...page('import { Button } from "@repo/ui/button"; export default Button;'),
    "packages/ui/src/button.tsx":
      'import "./button.css";\nimport styles from "./card.module.css";\nexport const Button = () => <b className={styles.x} />;',
    "packages/ui/src/button.css": '@import "./base.css";\n.b { background: url("./icon.svg"); }\n',
    "packages/ui/src/base.css": "/* url(./commented.svg) */ .base {}",
    "packages/ui/src/icon.svg": "<svg />",
    "packages/ui/src/commented.svg": "<svg />",
    "packages/ui/src/card.module.css": '.x { composes: y from "./shared.module.css"; }',
    "packages/ui/src/shared.module.css": ".y {}",
    "packages/ui/src/unused.css": ".z {}",
  });
  assert.deepEqual(w.run().files(), [
    "package.json",
    "src/base.css",
    "src/button.css",
    "src/button.tsx",
    "src/card.module.css",
    "src/icon.svg",
    "src/shared.module.css",
  ]);
});

test("new URL with import.meta.url and require.resolve with a literal follow the file", (t) => {
  const w = workspace(t, {
    ...page('import { worker, data } from "@repo/ui/utils"; export const result = [worker, data];'),
    "packages/ui/src/utils/index.ts":
      'export const worker = new URL("./worker.ts", import.meta.url);\nexport const data = require.resolve("./data.json");\n',
    "packages/ui/src/utils/worker.ts": "postMessage(1);",
    "packages/ui/src/utils/data.json": "{}",
    "packages/ui/src/utils/other.json": "{}",
  });
  const run = w.run();
  assert.deepEqual(run.files(), ["package.json", "src/utils/data.json", "src/utils/index.ts", "src/utils/worker.ts"]);
  assert.deepEqual(run.report.fallbacks, []);
});

test("a computed import with a static prefix includes the files it can match", (t) => {
  const w = workspace(t, {
    ...page('import { load } from "@repo/ui/utils"; export const result = load;'),
    "packages/ui/src/utils/index.ts": "export const load = (lang: string) => import(`./locales/${lang}.ts`);",
    "packages/ui/src/utils/locales/en.ts": "export default 'en';",
    "packages/ui/src/utils/locales/pl.ts": "export default 'pl';",
    "packages/ui/src/utils/locales/notes.md": "not code the pattern matches",
    "packages/ui/src/utils/other/x.ts": "export default 'x';",
  });
  const run = w.run();
  assert.deepEqual(run.files(), ["package.json", "src/utils/index.ts", "src/utils/locales/en.ts", "src/utils/locales/pl.ts"]);
  assert.deepEqual(run.report.fallbacks, []);
});

test("a computed import without a prefix includes its package whole and is reported", (t) => {
  const w = workspace(t, {
    ...page('import { load } from "@repo/ui/utils"; export const result = load;'),
    "packages/ui/src/utils/index.ts": "export const load = (name: string) => import(name);",
    "packages/ui/src/far/away.ts": "export default 1;",
  });
  const run = w.run();
  assert.ok(run.files().includes("src/far/away.ts"));
  assert.deepEqual(
    run.report.fallbacks.map(({ file, width, included }) => ({ file, width, included })),
    [{ file: "packages/ui/src/utils/index.ts", width: "package", included: ["packages/ui"] }],
  );
  assert.throws(() => w.run("runtime", { strict: true }), /import\(name\) needs packages\/ui whole \(package fallback\)/);
});

test("file system access in a package includes the module's directory", (t) => {
  const w = workspace(t, {
    ...page('import { read } from "@repo/ui/utils"; export const result = read;'),
    "packages/ui/src/utils/index.ts":
      'import fs from "node:fs";\nexport const read = () => fs.readFileSync(new URL("./" + "data.txt", import.meta.url));\n',
    "packages/ui/src/utils/data.txt": "data",
    "packages/ui/src/other/data.txt": "data",
  });
  const run = w.run();
  assert.ok(run.files().includes("src/utils/data.txt"));
  assert.ok(!run.files().includes("src/other/data.txt"));
  assert.ok(run.report.fallbacks.every((f) => f.width === "directory"));
  assert.throws(() => w.run("runtime", { strict: true }), /directory fallback/);
});

// ---------------------------------------------------------------------------
// Next entries

test("Next entries follow the App Router, Pages, root files and pageExtensions", (t) => {
  const w = workspace(t, {
    "apps/web/app/page.tsx": "",
    "apps/web/app/blog/[slug]/layout.tsx": "",
    "apps/web/app/blog/[slug]/opengraph-image.tsx": "",
    "apps/web/app/components/helper.tsx": "",
    "apps/web/pages/about.tsx": "",
    "apps/web/middleware.ts": "",
    "apps/web/src/instrumentation.ts": "",
    "apps/web/next.config.js": "export default {};",
  });
  const app = path.join(w.root, "apps/web");
  const relative = () => nextEntries(app).files.map((f) => path.relative(app, f));
  assert.deepEqual(relative(), [
    "app/blog/[slug]/layout.tsx",
    "app/blog/[slug]/opengraph-image.tsx",
    "app/page.tsx",
    "middleware.ts",
    "next.config.js",
    "pages/about.tsx",
    "src/instrumentation.ts",
  ]);

  w.write({ "apps/web/next.config.js": 'export default { pageExtensions: ["page.tsx"] };', "apps/web/pages/index.page.tsx": "" });
  assert.deepEqual(relative(), ["middleware.ts", "next.config.js", "pages/index.page.tsx", "src/instrumentation.ts"]);

  w.write({ "apps/web/next.config.js": "export default { pageExtensions: extensions };" });
  const unreadable = nextEntries(app);
  assert.equal(unreadable.notes.length, 1);
  assert.ok(unreadable.files.some((f) => f.endsWith("components/helper.tsx")));
});

// ---------------------------------------------------------------------------
// Workspace packages

test("a workspace package another package depends on is projected and linked", async (t) => {
  const w = workspace(
    t,
    {
      ...page('import { label } from "@repo/ui/utils"; export const result = label();'),
      "packages/ui/src/utils/index.ts": 'import { core } from "@repo/core";\nexport const label = () => `ui ${core}`;\n',
      "packages/core/package.json": JSON.stringify({ name: "@repo/core", sideEffects: false, exports: { ".": "./src/index.ts" } }),
      "packages/core/src/index.ts": "export const core = 1;\nexport const unusedCore = 2;\n",
    },
    { ui: { ...UI, dependencies: { "@repo/core": "workspace:*" } } },
  );
  const run = w.run();
  assert.doesNotMatch(run.read("packages/core/src/index.ts")!, /unusedCore/);
  const manifest = JSON.parse(run.read("projection.json")!) as Manifest;
  assert.deepEqual(manifest, {
    app: ["@repo/ui"],
    packages: [
      { name: "@repo/core", dir: "packages/core", links: [] },
      { name: "@repo/ui", dir: "packages/ui", links: ["@repo/core"] },
    ],
  });
  assert.deepEqual((await w.equivalent()).exports, { result: "ui 1" });
});

test("link-projection refuses to write over a package or a link", (t) => {
  const w = workspace(t, { ...page('import "@repo/ui/utils";'), "packages/ui/src/utils/index.ts": "export const a = 1;" });
  const { out } = w.run();
  const target = path.join(w.root, "linked");
  linkProjection(out, target, "apps/web");
  assert.equal(fs.readlinkSync(path.join(target, "apps/web/node_modules/@repo/ui")), "../../../../packages/ui");
  assert.throws(() => linkProjection(out, target, "apps/web"), /package\.json already exists/);
  fs.rmSync(path.join(target, "packages"), { recursive: true });
  assert.throws(() => linkProjection(out, target, "apps/web"), /node_modules\/@repo\/ui already exists/);
});

// ---------------------------------------------------------------------------
// Types

test("the type view declares the used utilities; a body edit leaves it unchanged", (t) => {
  const w = workspace(t, {
    ...page('import { add } from "@repo/ui/utils"; export const result: number = add(1);'),
    "packages/ui/src/utils/index.ts": 'export { add } from "./add";\nexport { sub } from "./sub";\n',
    "packages/ui/src/utils/add/index.ts": "export const add = (a: number) => a + 1;",
    "packages/ui/src/utils/sub/index.ts": "export const sub = (a: number) => a - 1;",
  });
  const run = w.run("types");
  assert.deepEqual(run.files(), ["package.json", "src/utils/add/index.ts", "src/utils/index.ts"]);
  assert.match(run.read("packages/ui/src/utils/add/index.ts")!, /export declare const add: \(a: number\) => number;/);
  const snapshot = run.snapshot();

  w.write({ "packages/ui/src/utils/add/index.ts": "export const add = (a: number) => { const step = 1; return a + step; };" });
  assert.equal(w.run("types").snapshot(), snapshot);
  w.write({ "packages/ui/src/utils/add/index.ts": "export const add = (a: number, b = 1) => a + b;" });
  assert.notEqual(w.run("types").snapshot(), snapshot);
});

test("type-only imports reach the type view but not the runtime projection", (t) => {
  const w = workspace(t, {
    ...page('import type { Props } from "@repo/ui/widget"; export const props: Props = {};'),
    "packages/ui/src/widget.tsx": "export type Props = {};\nexport const Widget = () => null;\n",
  });
  assert.ok(w.run("types").files().includes("src/widget.tsx"));
  assert.ok(!w.run("runtime").files().includes("src/widget.tsx"));
});

test("a module whose declarations do not emit cleanly keeps its source in the type view", (t) => {
  const source = "export const add = (a: number) => a + missing;\nexport const sub = 1;\n";
  const w = workspace(t, {
    ...page('import { add } from "@repo/ui/utils/add"; add(1);'),
    "packages/ui/src/utils/add/index.ts": source,
  });
  assert.equal(w.run("types").read("packages/ui/src/utils/add/index.ts"), source);
});

// ---------------------------------------------------------------------------
// Tailwind

test("a directory Tailwind scans is copied whole and reported, strict or not", (t) => {
  const w = workspace(t, {
    "apps/web/app/layout.tsx": 'import "./globals.css";\nexport default function Layout() { return null; }',
    "apps/web/app/globals.css": '@import "tailwindcss";\n@source "../../../packages/ui/src";\n',
    "packages/ui/src/button.tsx": 'export const Button = () => <b className="p-4" />;',
  });
  const run = w.run("runtime", { strict: true });
  assert.ok(run.files().includes("src/button.tsx"));
  assert.deepEqual(
    run.report.fallbacks.map(({ width, included }) => ({ width, included })),
    [{ width: "scanned", included: ["packages/ui/src"] }],
  );
});

test("the report lands where --report points", (t) => {
  const w = workspace(t, { ...page('import "@repo/ui/utils";'), "packages/ui/src/utils/index.ts": "export const a = 1;" });
  const report = path.join(w.root, "report.json");
  const packages = [packageArgument(`@repo/ui=${path.join(w.root, "packages/ui")}=packages/ui`)];
  project({ mode: "runtime", app: path.join(w.root, "apps/web"), packages, out: path.join(w.root, "out"), root: w.root, report });
  const written = JSON.parse(fs.readFileSync(report, "utf8")) as Report;
  assert.equal(written.app, "apps/web");
  assert.deepEqual(written.packages["@repo/ui"], { files: 1, whole: 0, sliced: 1 });
});
