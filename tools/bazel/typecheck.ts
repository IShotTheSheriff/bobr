// Type-check one package. Apps compile against their projected UI types, so
// UI code they never reach cannot change this check's inputs.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const [packageDir, uiTypes] = process.argv.slice(2).map((p) => path.resolve(p)) as [string, string | undefined];
const resolve = (id: string) => require.resolve(id, { paths: [packageDir] });

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: packageDir,
    stdio: "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

let next;
try {
  next = path.join(path.dirname(resolve("next/package.json")), "dist/bin/next");
} catch {
  // Not a Next app.
}
// Route types and the validators for page, layout and route exports.
if (next) run(next, ["typegen"]);

const typescript = path.dirname(resolve("typescript/package.json"));
let project = path.join(packageDir, "tsconfig.json");
if (uiTypes) {
  const ts: typeof import("typescript") = require(typescript);
  const parsed = ts.getParsedCommandLineOfConfigFile(project, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  })!;
  const base = (parsed.options.pathsBasePath as string | undefined) || packageDir;
  // Overriding `paths` replaces the whole option, so keep the app's aliases.
  const paths = Object.fromEntries(
    Object.entries(parsed.options.paths || {}).map(([alias, targets]): [string, string[]] => [
      alias,
      targets.map((target) => path.resolve(base, target)),
    ]),
  );
  paths["@repo/ui/*"] = [path.join(uiTypes, "*")];
  project = path.join(packageDir, "tsconfig.bazel-typecheck.json");
  fs.writeFileSync(
    project,
    JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { paths } }),
  );
}
run(path.join(typescript, "lib/tsc.js"), ["--noEmit", "-p", project]);
