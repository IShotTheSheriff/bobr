const { test } = require("node:test");
const assert = require("node:assert/strict");
const { deploymentKey, findReusable, reusable } = require("./vercel-reuse.cjs");

function inputs() {
  return {
    artifact: "archive-sha",
    project: { id: "project", nodeVersion: "24.x", updatedAt: 1 },
    environment: { envs: [{ id: "env", updatedAt: 10, target: ["preview"] }] },
    team: "team",
    target: "preview",
    scope: "pr-6",
    cliVersion: "61.0.0",
  };
}
const options = {
  key: "key",
  scope: "pr-6",
  target: "preview",
  projectId: "project",
};
function ready() {
  return {
    id: "deployment",
    projectId: "project",
    readyState: "READY",
    target: null,
    meta: { bobrKey: "key", bobrScope: "pr-6" },
    url: "bobr-123.vercel.app",
  };
}

test("artifact, settings, secret rotation, scope, CLI and target changes require deployment", () => {
  const initial = deploymentKey(inputs());
  for (const change of [
    (i) => (i.artifact = "different-archive"),
    (i) => (i.project.nodeVersion = "26.x"),
    (i) => i.environment.envs[0].updatedAt++,
    (i) => (i.environment.envs = []),
    (i) => (i.scope = "pr-7"),
    (i) => (i.team = "other-team"),
    (i) => (i.target = "production"),
    (i) => (i.cliVersion = "62.0.0"),
  ]) {
    const input = inputs();
    change(input);
    assert.notEqual(deploymentKey(input), initial);
  }
});

test("deployment history and object key order do not change identity", () => {
  const input = inputs();
  input.project = {
    updatedAt: 2,
    nodeVersion: "24.x",
    id: "project",
    targets: { production: "other" },
    latestDeployments: ["new"],
  };
  assert.equal(deploymentKey(input), deploymentKey(inputs()));
});

test("secret values are excluded and incomplete environment inventories disable reuse", () => {
  const input = inputs();
  input.environment.envs[0].value = "never-publish-this";
  assert.equal(deploymentKey(input), deploymentKey(inputs()));
  delete input.environment.envs[0].updatedAt;
  assert.equal(deploymentKey(input), null);
  input.environment = { envs: [], hiddenProductionEnvCount: 1 };
  assert.equal(deploymentKey(input), null);
  input.environment = { envs: [] };
  input.project.sharedEnvironmentVariableIds = ["shared"];
  assert.equal(deploymentKey(input), null);
  assert.throws(
    () => deploymentKey({ ...input, environment: {} }),
    /inventory/,
  );
});

test("only a live successful matching deployment can be reused", () => {
  assert.equal(reusable(ready(), options), true);
  for (const patch of [
    { readyState: "ERROR" },
    { readyState: "CANCELED" },
    { readyState: "BUILDING" },
    { deletedAt: 1 },
    { isDisabled: true },
    { aliasError: { code: "failed" } },
    { projectId: "other" },
    { target: "production" },
    { meta: {} },
    { meta: { bobrKey: "key", bobrScope: "pr-7" } },
    { url: "evil.example" },
  ])
    assert.equal(reusable({ ...ready(), ...patch }, options), false);
  assert.equal(reusable(null, options), false);
  assert.equal(reusable(ready(), { ...options, key: null }), false);
});

test("production reuse requires the current production deployment, including after rollback", async () => {
  const opts = { ...options, target: "production", productionId: "deployment" };
  const deployed = { ...ready(), target: "production" };
  assert.equal(reusable(deployed, opts), true);
  assert.equal(
    reusable(deployed, { ...opts, productionId: "rolled-back-to" }),
    false,
  );
  const routes = [];
  assert.equal(
    await findReusable(async (route) => {
      routes.push(route);
      return deployed;
    }, opts),
    deployed,
  );
  assert.deepEqual(routes, ["/v13/deployments/deployment"]);
});

test("preview lookup paginates and ignores a deleted match before reusing a live one", async () => {
  const routes = [];
  const deployed = ready();
  const api = async (route) => {
    routes.push(route);
    if (route === "/v13/deployments/deleted") return null;
    if (route === "/v13/deployments/deployment") return deployed;
    const second = new URL(route, "https://api.vercel.com").searchParams.get(
      "until",
    );
    return {
      deployments: [
        { uid: second ? "deployment" : "deleted", meta: deployed.meta },
      ],
      pagination: { next: second ? null : 100 },
    };
  };
  assert.equal(await findReusable(api, options), deployed);
  assert.equal(routes.length, 4);
  assert.match(routes[2], /until=100/);
});

test("an API error fails instead of claiming reuse or silently deploying", async () => {
  await assert.rejects(
    findReusable(async () => {
      throw new Error("HTTP 403");
    }, options),
    /403/,
  );
});
