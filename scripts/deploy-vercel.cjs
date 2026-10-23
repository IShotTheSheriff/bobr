// Deploy the archive already built and tested by Bazel.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { digest, deploymentKey, findReusable } = require("./vercel-reuse.cjs");

async function main() {
  const [archive, target] = process.argv.slice(2);
  if (!archive || !["preview", "production"].includes(target))
    throw new Error(
      "Usage: node scripts/deploy-vercel.cjs ARCHIVE preview|production",
    );
  for (const key of [
    "VERCEL_TOKEN",
    "VERCEL_ORG_ID",
    "VERCEL_PROJECT_ID",
    "DEPLOY_SCOPE",
  ])
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  const team = process.env.VERCEL_ORG_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const scope = digest(process.env.DEPLOY_SCOPE);
  const artifact = createHash("sha256")
    .update(fs.readFileSync(archive))
    .digest("hex");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bobr-deploy-"));
  try {
    const output = path.join(cwd, ".vercel/output");
    fs.mkdirSync(output, { recursive: true });
    const extracted = spawnSync(
      "tar",
      ["-xf", path.resolve(archive), "-C", output],
      { stdio: "inherit" },
    );
    if (extracted.status !== 0)
      throw new Error("Cannot extract deployment archive");
    require("../tools/bazel/check-artifact.cjs")(output);
    const build = JSON.parse(fs.readFileSync(path.join(output, "builds.json")));
    if (build.target !== target)
      throw new Error(
        `Artifact target ${build.target} does not match ${target}`,
      );
    const platform = JSON.parse(
      fs.readFileSync(path.join(output, "bobr-build.json")),
    );
    if (
      platform.platform !== "linux" ||
      platform.arch !== "x64" ||
      platform.node !== 24
    )
      throw new Error(
        "Vercel deployment requires the Linux x64 Node 24 CI artifact",
      );

    async function api(route) {
      const url = new URL(route, "https://api.vercel.com");
      url.searchParams.set("teamId", team);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) return null;
      // Never log API bodies, which can contain environment values.
      if (!response.ok)
        throw new Error(
          `Vercel API request failed with HTTP ${response.status}`,
        );
      return response.json();
    }
    const project = await api(`/v9/projects/${encodeURIComponent(projectId)}`);
    if (project?.id !== projectId || project.accountId !== team)
      throw new Error("Vercel project/account mismatch");
    const environment = await api(
      `/v10/projects/${encodeURIComponent(projectId)}/env?decrypt=false`,
    );
    const cliPackage = require.resolve("vercel/package.json");
    const key = deploymentKey({
      artifact,
      project,
      environment,
      team,
      target,
      scope,
      cliVersion: require(cliPackage).version,
    });
    const match =
      process.env.VERCEL_FORCE_DEPLOY === "1"
        ? null
        : await findReusable(api, {
            key,
            scope,
            target,
            projectId,
            productionId: project.targets?.production?.id,
          });
    let url;
    if (match) {
      url = `https://${match.url}`;
      console.log(`Reusing successful ${target} deployment: ${url}`);
    } else {
      fs.writeFileSync(
        path.join(cwd, ".vercel/project.json"),
        JSON.stringify({ orgId: team, projectId }),
      );
      const result = spawnSync(
        process.execPath,
        [
          path.join(path.dirname(cliPackage), "dist/vc.js"),
          "deploy",
          "--prebuilt",
          "--yes",
          "--meta",
          `bobrKey=${key || randomUUID()}`,
          "--meta",
          `bobrScope=${scope}`,
          ...(target === "production" ? ["--prod"] : []),
        ],
        {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
          env: { ...process.env, VERCEL_TELEMETRY_DISABLED: "1" },
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`Vercel deploy failed with exit code ${result.status}`);
      url = result.stdout.trim();
      if (!/^https:\/\/[a-zA-Z0-9.-]+\.vercel\.app$/.test(url))
        throw new Error("Missing Vercel deployment URL");
      const deployed = await api(`/v13/deployments/${new URL(url).hostname}`);
      if (
        deployed?.readyState !== "READY" ||
        deployed.aliasError ||
        deployed.projectId !== projectId ||
        (deployed.target || "preview") !== target
      )
        throw new Error("Deployment is not ready");
      console.log(`Created ${target} deployment: ${url}`);
    }
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `url=${url}\nreused=${Boolean(match)}\n`,
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `${match ? "Reused" : "Created"} ${target} deployment: ${url}\n`,
      );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
