import { createHash } from "node:crypto";

interface VercelEnv {
  id?: string;
  updatedAt?: number;
  target?: string[] | string;
  gitBranch?: string;
  [key: string]: unknown;
}

interface VercelEnvironment {
  envs?: VercelEnv[];
  hiddenProductionEnvCount?: number;
}

interface VercelProject {
  id?: string;
  accountId?: string;
  sharedEnvironmentVariableIds?: string[];
  targets?: { production?: { id?: string } };
  [key: string]: unknown;
}

interface VercelDeployment {
  id?: string;
  uid?: string;
  url?: string;
  readyState?: string;
  deletedAt?: unknown;
  deleted?: unknown;
  aliasError?: unknown;
  isDisabled?: unknown;
  projectId?: string;
  target?: string | null;
  meta?: { bobrKey?: string; bobrScope?: string };
}

interface VercelDeploymentList {
  deployments?: (VercelDeployment & { uid: string })[];
  pagination?: { next?: number | null };
}

interface KeyInputs {
  artifact: string;
  project: VercelProject;
  environment: VercelEnvironment | null;
  team: string;
  target: string;
  scope: string;
  cliVersion: string;
}

interface ReuseOptions {
  key: string | null;
  scope: string;
  target: string;
  projectId: string;
  productionId?: string;
}

type VercelApi = <T>(route: string) => Promise<T | null>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}

function digest(value: unknown) {
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
}: KeyInputs) {
  if (!Array.isArray(environment?.envs))
    throw new Error("Missing Vercel environment inventory");
  // Hidden or unversioned secrets cannot establish that runtime settings match.
  if (
    (environment.hiddenProductionEnvCount ?? 0) > 0 ||
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
  (envs as { id: string }[]).sort((a, b) => a.id.localeCompare(b.id));
  const settings: Record<string, unknown> = { ...project };
  // Deployment history changes after an upload without changing project settings.
  // `crons` records the production deployment whose cron jobs run; the jobs
  // themselves come from the archive. Vercel applies protection bypass secrets
  // to every deployment at request time, so adding or rotating one must not
  // force a redeploy.
  for (const name of [
    "latestDeployments",
    "targets",
    "crons",
    "lastAliasRequest",
    "lastRollbackTarget",
    "updatedAt",
    "env",
    "protectionBypass",
  ])
    delete settings[name];
  return digest({
    version: 3,
    artifact,
    settings,
    envs,
    team,
    target,
    scope,
    cliVersion,
  });
}

function reusable(deployment: VercelDeployment | null, { key, scope, target, projectId, productionId }: ReuseOptions) {
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

async function findReusable(api: VercelApi, options: ReuseOptions) {
  if (!options.key) return null;
  if (options.target === "production") {
    if (!options.productionId) return null;
    const deployment = await api<VercelDeployment>(
      `/v13/deployments/${encodeURIComponent(options.productionId)}`,
    );
    return reusable(deployment, options) ? deployment : null;
  }
  let until: number | undefined;
  // A bounded search may miss an old match, which safely creates a new deployment.
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({
      projectId: options.projectId,
      target: "preview",
      state: "READY",
      limit: "100",
    });
    if (until) query.set("until", String(until));
    const result = await api<VercelDeploymentList>(`/v7/deployments?${query}`);
    if (!Array.isArray(result?.deployments))
      throw new Error("Missing Vercel deployment list");
    for (const entry of result.deployments) {
      if (
        entry.meta?.bobrKey !== options.key ||
        entry.meta?.bobrScope !== options.scope
      )
        continue;
      const deployment = await api<VercelDeployment>(
        `/v13/deployments/${encodeURIComponent(entry.uid)}`,
      );
      if (reusable(deployment, options)) return deployment;
    }
    if (!result.pagination?.next || result.pagination.next === until) break;
    until = result.pagination.next as number;
  }
  return null;
}

// After an Instant Rollback, Vercel stops moving production domains to new
// production deployments until someone promotes one. CI must not undo a
// person's rollback, so it reports the pin instead.
function productionPin(project: VercelProject | null, deployment: VercelDeployment, url: string) {
  const serving = project?.targets?.production?.id;
  if (!serving || serving === deployment.id) return null;
  return (
    `Production still serves ${serving}, for example after a rollback, so ` +
    `${url} is ready but not live. Run \`vercel promote ${url}\` to serve it.`
  );
}

export type { VercelApi, VercelDeployment, VercelEnvironment, VercelProject };
export { digest, deploymentKey, reusable, findReusable, productionPin };
