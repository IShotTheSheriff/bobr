// Type-check one package with its tsconfig.json. A Next app first generates
// its route types. Usage: node tools/ci/typecheck.ts <package dir>
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const packageDir = path.resolve(process.argv[2]!);
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
run(path.join(typescript, "lib/tsc.js"), ["--noEmit", "-p", path.join(packageDir, "tsconfig.json")]);
