const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

// These checked-in settings make the build independent of Vercel account state.
// Deployment supplies the real project link after retrieving this artifact.
const settings = JSON.parse(fs.readFileSync("vercel-build.json", "utf8"));
const appDirectory = process.cwd();
const rootDirectory = path.resolve("../..");
settings.rootDirectory = path.relative(rootDirectory, appDirectory);
process.chdir(rootDirectory);
fs.mkdirSync(".vercel", { recursive: true });
fs.writeFileSync(
  ".vercel/project.json",
  JSON.stringify({
    projectId: "prj_bobr_offline",
    orgId: "team_bobr_offline",
    settings,
  }),
);
const cli = path.join(
  path.dirname(require.resolve("vercel/package.json")),
  "dist/vc.js",
);
const result = spawnSync(
  process.execPath,
  [
    cli,
    "build",
    "--standalone",
    "--output",
    path.join(appDirectory, ".vercel/output"),
    "--target",
    process.env.BOBR_DEPLOY_ENV || "preview",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(path.join(__dirname, "trace-fs.cjs")).href}`,
      VERCEL_TELEMETRY_DISABLED: "1",
      NO_UPDATE_NOTIFIER: "1",
    },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
// Stage only deployment output for the archive. Account metadata and local
// environment files must stay outside cached application output.
fs.renameSync(
  path.join(appDirectory, ".vercel/output"),
  path.join(appDirectory, "vercel_output"),
);
require("./check-artifact.cjs")(path.join(appDirectory, "vercel_output"));

fs.writeFileSync(
  path.join(appDirectory, "vercel_output/bobr-build.json"),
  JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: Number(process.versions.node.split(".")[0]),
  }),
);

// The archive is the sole deployment output. It preserves package symlinks
// through remote caching and runfiles, where expanded directories can differ.
require("tar").c(
  {
    cwd: path.join(appDirectory, "vercel_output"),
    file: path.join(appDirectory, "vercel_output.tar"),
    sync: true,
    portable: true,
    noMtime: true,
  },
  ["."],
);

fs.rmSync(path.join(appDirectory, "vercel_output"), { recursive: true });
