// Builds one Next app with the locked Vercel CLI and writes the deployment
// archive. Usage: node tools/ci/build-app.ts <app dir> <archive> <preview|production>
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as tar from "tar";
import checkArtifact from "./check-artifact.ts";

const require = createRequire(import.meta.url);

export default function buildApp(appDirectory: string, archive: string, target: string) {
  const rootDirectory = path.resolve(import.meta.dirname, "../..");
  // These checked-in settings make the build independent of Vercel account state.
  // Deployment supplies the real project link after retrieving this artifact.
  const settings = JSON.parse(fs.readFileSync(path.join(appDirectory, "vercel-build.json"), "utf8"));
  settings.rootDirectory = path.relative(rootDirectory, appDirectory);
  fs.mkdirSync(path.join(rootDirectory, ".vercel"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDirectory, ".vercel/project.json"),
    JSON.stringify({ projectId: "prj_bobr_offline", orgId: "team_bobr_offline", settings }),
  );
  const output = path.join(appDirectory, ".vercel/output");
  fs.rmSync(output, { recursive: true, force: true });
  const cli = path.join(path.dirname(require.resolve("vercel/package.json")), "dist/vc.js");
  const result = spawnSync(
    process.execPath,
    [cli, "build", "--standalone", "--output", output, "--target", target],
    {
      cwd: rootDirectory,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        VERCEL_TELEMETRY_DISABLED: "1",
        NO_UPDATE_NOTIFIER: "1",
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`vercel build exited with ${result.status}`);
  checkArtifact(output);
  fs.writeFileSync(
    path.join(output, "bobr-build.json"),
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: Number(process.versions.node.split(".")[0]),
    }),
  );
  // The archive is the sole deployment output. It keeps the package symlinks
  // that Vercel's function bundles hold.
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  tar.c({ cwd: output, file: archive, sync: true, portable: true, noMtime: true }, ["."]);
  fs.rmSync(output, { recursive: true });
}

if (import.meta.main) {
  const [app, archive, target] = process.argv.slice(2);
  buildApp(path.resolve(app!), path.resolve(archive!), target || "preview");
}
