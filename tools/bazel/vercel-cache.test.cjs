const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { createCacheProxy, artifactId, sign } = require("./vercel-cache.cjs");

const HASH = "a".repeat(64);

// Stores artifacts like Vercel's /v8/artifacts API, including x-artifact-tag.
async function fakeVercel(t, { failFirst } = {}) {
  const store = new Map();
  const requests = [];
  let pending = failFirst;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const id = url.pathname.replace("/v8/artifacts/", "");
    requests.push(`${req.method} ${id}`);
    if (req.headers.authorization !== "Bearer token" || url.searchParams.get("teamId") !== "team")
      return res.writeHead(403).end();
    if (pending) {
      const status = pending;
      pending = undefined;
      return res.writeHead(status, { "retry-after": "0" }).end();
    }
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        store.set(id, { body: Buffer.concat(chunks), tag: req.headers["x-artifact-tag"] });
        res.writeHead(202).end();
      });
      return;
    }
    const entry = store.get(id);
    if (!entry) return res.writeHead(404).end();
    res.writeHead(200, entry.tag ? { "x-artifact-tag": entry.tag } : {});
    res.end(req.method === "GET" ? entry.body : undefined);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { api: `http://127.0.0.1:${server.address().port}`, store, requests };
}

async function proxy(t, api, options) {
  const { server, stats } = createCacheProxy({ token: "token", teamId: "team", api, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    stats,
    get: (path) => fetch(base + path),
    put: (path, body) => fetch(base + path, { method: "PUT", body }),
  };
}

test("a developer upload is readable by another developer", async (t) => {
  const { api } = await fakeVercel(t);
  const writer = await proxy(t, api, { upload: true });
  assert.equal((await writer.put(`/cas/${HASH}`, "blob")).status, 200);
  const reader = await proxy(t, api, {});
  const response = await reader.get(`/cas/${HASH}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "blob");
});

test("without upload permission nothing is stored", async (t) => {
  const { api, store } = await fakeVercel(t);
  const reader = await proxy(t, api, {});
  assert.equal((await reader.put(`/ac/${HASH}`, "result")).status, 403);
  assert.equal(store.size, 0);
});

test("CI never reads developer uploads", async (t) => {
  const { api } = await fakeVercel(t);
  const developer = await proxy(t, api, { upload: true });
  await developer.put(`/ac/${HASH}`, "developer result");
  const ci = await proxy(t, api, { signingKey: "ci-key" });
  assert.equal((await ci.get(`/ac/${HASH}`)).status, 404);
});

test("CI ignores action results it did not sign and accepts its own", async (t) => {
  const { api, store } = await fakeVercel(t);
  const ci = await proxy(t, api, { signingKey: "ci-key", upload: true });
  // Anyone with a team token can write into CI's namespace, but not sign.
  store.set(artifactId("ci", "ac", HASH), { body: Buffer.from("forged") });
  const forged = await ci.get(`/ac/${HASH}`);
  assert.equal(forged.status, 404);
  assert.equal(ci.stats.unsigned, 1);
  await ci.put(`/ac/${HASH}`, "signed result");
  const id = artifactId("ci", "ac", HASH);
  assert.equal(store.get(id).tag, sign("ci-key", id, Buffer.from("signed result")));
  assert.equal(await (await ci.get(`/ac/${HASH}`)).text(), "signed result");
});

test("developers also read CI's results, then their own", async (t) => {
  const { api } = await fakeVercel(t);
  const ci = await proxy(t, api, { signingKey: "ci-key", upload: true });
  await ci.put(`/cas/${HASH}`, "from ci");
  const developer = await proxy(t, api, {});
  assert.equal(await (await developer.get(`/cas/${HASH}`)).text(), "from ci");
});

test("a rate-limited request waits and retries", async (t) => {
  const { api, requests } = await fakeVercel(t, { failFirst: 429 });
  const writer = await proxy(t, api, { upload: true });
  assert.equal((await writer.put(`/cas/${HASH}`, "blob")).status, 200);
  assert.equal(requests.length, 2);
});

test("an upstream failure is an error, not a miss", async (t) => {
  const { api } = await fakeVercel(t, { failFirst: 500 });
  const reader = await proxy(t, api, {});
  assert.equal((await reader.get(`/ac/${HASH}`)).status, 502);
  assert.equal(reader.stats.errors, 1);
});

test("only Bazel cache paths are served", async (t) => {
  const { api } = await fakeVercel(t);
  const reader = await proxy(t, api, {});
  assert.equal((await reader.get("/ac/not-a-digest")).status, 400);
});
