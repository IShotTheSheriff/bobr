// Type-check one package. Apps compile against the type view of their
// workspace packages, so code they never reach cannot change this check's inputs.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import linkProjection from "./link-projection.ts";

const require = createRequire(import.meta.url);

const [packageDir, projection] = process.argv.slice(2).map((p) => path.resolve(p)) as [string, string | undefined];
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
// The app's type view of its workspace packages, at the packages' own paths.
if (projection) linkProjection(projection, process.cwd(), path.relative(process.cwd(), packageDir));
run(path.join(typescript, "lib/tsc.js"), ["--noEmit", "-p", path.join(packageDir, "tsconfig.json")]);
