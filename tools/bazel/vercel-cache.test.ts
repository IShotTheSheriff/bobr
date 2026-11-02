import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { createCacheProxy, artifactId, sign } from "./vercel-cache.ts";

const HASH = "a".repeat(64);

// Stores artifacts like Vercel's /v8/artifacts API, including x-artifact-tag.
async function fakeVercel(t: TestContext, { failFirst }: { failFirst?: number } = {}) {
  const store = new Map<string, { body: Buffer; tag?: string | string[] }>();
  const requests: string[] = [];
  let pending = failFirst;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
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
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, requests };
}

async function proxy(
  t: TestContext,
  api: string,
  options?: Partial<Parameters<typeof createCacheProxy>[0]>,
) {
  const { server, stats } = createCacheProxy({ token: "token", teamId: "team", api, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    stats,
    get: (path: string) => fetch(base + path),
    put: (path: string, body: string) => fetch(base + path, { method: "PUT", body }),
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
  assert.equal(store.get(id)!.tag, sign("ci-key", id, Buffer.from("signed result")));
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

// Starts the proxy in GitHub Actions the way scripts/bazel.py does, with Vercel's
// status check answered by a stub.
function runInActions(t: TestContext, status: string) {
  const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "vercel-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, "status.mjs");
  fs.writeFileSync(stub, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify({ status }))});`);
  const child = spawn(process.execPath, ["--import", pathToFileURL(stub).href, path.join(import.meta.dirname, "vercel-cache.ts")], {
    env: { ...process.env, GITHUB_ACTIONS: "true", VERCEL_TOKEN: "token", BOBR_VERCEL_TEAM: "team" },
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const listening = new Promise<void>((resolve) =>
    child.stdout.on("data", (chunk) => (stdout += chunk).includes("\n") && resolve()),
  );
  const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
  return { child, listening, exit };
}

test("in GitHub Actions an unavailable cache is a run warning", async (t) => {
  const { code, stderr } = await runInActions(t, "disabled").exit;
  assert.equal(code, 1);
  assert.equal(stderr, "::warning title=Vercel cache::Vercel's Remote Cache is unavailable: disabled\n");
});

test("in GitHub Actions the counts notice starts its own line", async (t) => {
  // Bazel's output ends in a color reset without a newline, and the runner reads
  // a command only at the start of a line.
  const run = runInActions(t, "enabled");
  await run.listening;
  run.child.kill("SIGTERM");
  const { code, stderr } = await run.exit;
  assert.equal(code, 0);
  assert.equal(stderr, "\n::notice title=Vercel cache::Vercel cache: 0 hits, 0 misses, 0 uploads\n");
});
