// Reproduce the acceptance gaps found during the Bazel evaluation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const projectUi = require("../tools/bazel/project-ui.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobr-projection-review-"));

async function fixture(name, appSource, sources) {
  const dir = path.join(root, name);
  const app = path.join(dir, "app");
  const source = path.join(dir, "ui");
  const output = path.join(dir, "output");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(app, "page.ts"), appSource);
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      sideEffects: true,
      exports: { "./utils": "./src/utils/index.ts", "./*": "./src/*.tsx" },
    }),
  );
  for (const [file, content] of Object.entries(sources)) {
    const target = path.join(source, "src", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  await projectUi(app, source, output);
  return {
    app,
    source,
    output,
    utility: fs.readFileSync(path.join(output, "utils/index.js"), "utf8"),
  };
}

async function evaluate(app, alias) {
  delete globalThis.__bobrReviewEffect;
  const result = await esbuild.build({
    entryPoints: [path.join(app, "page.ts")],
    alias: { "@repo/ui": alias },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const code = result.outputFiles[0].text + "\n// " + alias;
  return (
    await import(
      "data:text/javascript;base64," + Buffer.from(code).toString("base64")
    )
  ).result;
}

async function main() {
  const effect = await fixture(
    "effect",
    'import { Widget } from "@repo/ui/widget"; export const result = Widget();',
    {
      "widget.tsx":
        'import "./utils"; export const Widget = () => globalThis.__bobrReviewEffect;',
      "utils/index.ts": "globalThis.__bobrReviewEffect = 42;",
    },
  );
  const original = await evaluate(effect.app, path.join(effect.source, "src"));
  const projected = await evaluate(effect.app, effect.output);
  assert.equal(original, 42, "The source fixture must execute its effect");

  const unused = [];
  for (const value of [2, 3]) {
    unused.push(
      await fixture(
        "unused-" + value,
        'import { used } from "@repo/ui/utils"; export const result = used;',
        {
          "unused-widget.tsx":
            'import { unused } from "@repo/ui/utils"; export const Widget = () => unused;',
          "utils/index.ts": `export const used = 1; export const unused = ${value};`,
        },
      ),
    );
  }
  const results = [
    {
      requirement: "preserve a component's relative side-effect import",
      pass: original === projected,
      original,
      projected: projected ?? null,
    },
    {
      requirement: "ignore a utility used only by an unreachable component",
      pass: unused[0].utility === unused[1].utility,
      before: unused[0].utility,
      after: unused[1].utility,
    },
  ];
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => !result.pass)) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    delete globalThis.__bobrReviewEffect;
    fs.rmSync(root, { recursive: true, force: true });
  });
