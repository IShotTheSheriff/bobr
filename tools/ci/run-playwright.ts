// Serves a deployment archive and runs a Playwright suite against it.
// Usage: node tools/ci/run-playwright.ts <archive> <playwright.config.ts>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [archive, config] = process.argv.slice(2).map((value) => path.resolve(value)) as [string, string];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bobr-browser-"));
// The functions run with a clean environment, as they would on Vercel.
const server = fork(path.join(import.meta.dirname, "artifact-server.ts"), [archive, temp], {
  execArgv: [],
  cwd: temp,
  env: { PATH: process.env.PATH, HOME: temp, NODE_ENV: "production" },
});
const stop = () => {
  server.kill();
  fs.rmSync(temp, { recursive: true, force: true });
};
let ready = false;
server.once("message", (port) => {
  ready = true;
  const cli = path.join(
    path.dirname(require.resolve("@playwright/test/package.json", { paths: [path.dirname(config)] })),
    "cli.js",
  );
  const test = spawn(process.execPath, [cli, "test", "--config", config], {
    stdio: "inherit",
    env: { ...process.env, CI: "1", BOBR_ARTIFACT_URL: `http://127.0.0.1:${port}` },
  });
  test.once("exit", (code) => {
    stop();
    process.exitCode = code ?? 1;
  });
  test.once("error", (error) => {
    console.error(error);
    stop();
    process.exitCode = 1;
  });
});
server.once("exit", (code) => {
  if (!ready) {
    fs.rmSync(temp, { recursive: true, force: true });
    process.exit(code || 1);
  }
});
process.on("exit", () => server.kill());
