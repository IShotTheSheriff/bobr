const path = require("node:path");
const { fork, spawn } = require("node:child_process");
const [output, executable, config] = process.argv
  .slice(2)
  .map((value) => path.resolve(value));
const temp = process.env.TEST_TMPDIR;
// Extract and run the artifact with native Node outside the runfiles fs patch.
const server = fork(
  path.join(__dirname, "artifact-server.cjs"),
  [output, temp],
  {
    execPath: process.env.JS_BINARY__NODE_BINARY || process.execPath,
    execArgv: [],
    cwd: temp,
    env: { PATH: process.env.PATH, HOME: temp, NODE_ENV: "production" },
  },
);
let ready = false;
server.once("message", (port) => {
  ready = true;
  const cli = path.join(
    path.dirname(
      require.resolve("@playwright/test/package.json", {
        paths: [path.dirname(config)],
      }),
    ),
    "cli.js",
  );
  const test = spawn(process.execPath, [cli, "test", "--config", config], {
    stdio: "inherit",
    env: {
      ...process.env,
      CI: "1",
      BOBR_ARTIFACT_URL: `http://127.0.0.1:${port}`,
      BOBR_CHROMIUM: executable,
      HOME: temp,
    },
  });
  test.once("exit", (code) => {
    server.kill();
    process.exitCode = code ?? 1;
  });
  test.once("error", (error) => {
    console.error(error);
    server.kill();
    process.exitCode = 1;
  });
});
server.once("exit", (code) => {
  if (!ready) process.exit(code || 1);
});
process.on("exit", () => server.kill());
