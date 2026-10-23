const { createHash } = require("node:crypto");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function deploymentKey({
  artifact,
  project,
  environment,
  team,
  target,
  scope,
  cliVersion,
}) {
  if (!Array.isArray(environment?.envs))
    throw new Error("Missing Vercel environment inventory");
  // Hidden or unversioned secrets cannot establish that runtime settings match.
  if (
    environment.hiddenProductionEnvCount > 0 ||
    project.sharedEnvironmentVariableIds?.length
  )
    return null;
  const envs = environment.envs.map((env) => {
    if (!env.id || !Number.isFinite(env.updatedAt)) return null;
    return {
      id: env.id,
      updatedAt: env.updatedAt,
      target: env.target,
      gitBranch: env.gitBranch,
    };
  });
  if (envs.includes(null)) return null;
  envs.sort((a, b) => a.id.localeCompare(b.id));
  const settings = { ...project };
  // Deployment history changes after an upload without changing project settings.
  for (const name of [
    "latestDeployments",
    "targets",
    "lastAliasRequest",
    "lastRollbackTarget",
    "updatedAt",
    "env",
  ])
    delete settings[name];
  return digest({
    version: 1,
    artifact,
    settings,
    envs,
    team,
    target,
    scope,
    cliVersion,
  });
}

function reusable(deployment, { key, scope, target, projectId, productionId }) {
  return Boolean(
    key &&
    deployment &&
    deployment.readyState === "READY" &&
    !deployment.deletedAt &&
    !deployment.deleted &&
    !deployment.aliasError &&
    !deployment.isDisabled &&
    deployment.projectId === projectId &&
    (deployment.target || "preview") === target &&
    deployment.meta?.bobrKey === key &&
    deployment.meta?.bobrScope === scope &&
    (target !== "production" || deployment.id === productionId) &&
    typeof deployment.url === "string" &&
    /^[a-zA-Z0-9.-]+\.vercel\.app$/.test(deployment.url),
  );
}

async function findReusable(api, options) {
  if (!options.key) return null;
  if (options.target === "production") {
    if (!options.productionId) return null;
    const deployment = await api(
      `/v13/deployments/${encodeURIComponent(options.productionId)}`,
    );
    return reusable(deployment, options) ? deployment : null;
  }
  let until;
  // A bounded search may miss an old match, which safely creates a new deployment.
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({
      projectId: options.projectId,
      target: "preview",
      state: "READY",
      limit: "100",
    });
    if (until) query.set("until", String(until));
    const result = await api(`/v7/deployments?${query}`);
    if (!Array.isArray(result?.deployments))
      throw new Error("Missing Vercel deployment list");
    for (const entry of result.deployments) {
      if (
        entry.meta?.bobrKey !== options.key ||
        entry.meta?.bobrScope !== options.scope
      )
        continue;
      const deployment = await api(
        `/v13/deployments/${encodeURIComponent(entry.uid)}`,
      );
      if (reusable(deployment, options)) return deployment;
    }
    if (!result.pagination?.next || result.pagination.next === until) break;
    until = result.pagination.next;
  }
  return null;
}

module.exports = { digest, deploymentKey, reusable, findReusable };
