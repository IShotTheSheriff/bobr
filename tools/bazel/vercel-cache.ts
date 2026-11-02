// Serve Bazel's HTTP cache protocol on localhost and store entries in Vercel's
// Remote Cache, so a team shares Bazel results through its Vercel account.
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

interface CacheProxyOptions {
  token: string;
  teamId: string;
  signingKey?: string;
  upload?: boolean;
  api?: string;
  fetchImpl?: typeof fetch;
}

const API = "https://api.vercel.com";

// Bazel keys are SHA-256 digests. CI and developers write separate namespaces,
// so developer uploads never become CI's results.
const artifactId = (namespace: string, kind: string, hash: string) =>
  crypto.createHash("sha256").update(`bobr:${namespace}:${kind}:${hash}`).digest("hex");

function sign(key: string, artifact: string, body: Buffer) {
  return crypto.createHmac("sha256", key).update(artifact).update(body).digest("base64");
}

function sameTag(a: string | null, b: string) {
  const left = Buffer.from(a || "");
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readBody(req: http.IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {object} options
 * @param {string} options.token Vercel token with access to the team.
 * @param {string} options.teamId Vercel team that owns the cache.
 * @param {string} [options.signingKey] CI's key. With it, the proxy reads and
 *   writes only CI's namespace and ignores action results it did not sign.
 * @param {boolean} [options.upload] Store results Bazel uploads.
 */
function createCacheProxy({ token, teamId, signingKey, upload = false, api = API, fetchImpl = fetch }: CacheProxyOptions) {
  const read = signingKey ? ["ci"] : ["ci", "dev"];
  const write = signingKey ? "ci" : "dev";
  const stats = { hits: 0, misses: 0, uploads: 0, unsigned: 0, errors: 0 };

  async function call(method: string, artifact: string, init: { body?: Buffer; headers?: Record<string, string> } = {}) {
    const url = new URL(`/v8/artifacts/${artifact}`, api);
    url.searchParams.set("teamId", teamId);
    // Hobby plans allow 100 requests a minute; wait instead of failing a build.
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url, {
        ...(init as RequestInit),
        method,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status !== 429 || attempt === 5) return response;
      await response.arrayBuffer();
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      await wait(Math.min(Number.isFinite(seconds) ? seconds * 1000 : 1000 * 2 ** attempt, 30_000));
    }
  }

  async function get(kind: string, hash: string) {
    for (const namespace of read) {
      const artifact = artifactId(namespace, kind, hash);
      const response = await call("GET", artifact);
      if (response.status === 404) {
        await response.arrayBuffer();
        continue;
      }
      if (!response.ok) throw new Error(`Vercel cache read failed: HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      // Bazel checks blob digests itself; action results need CI's signature.
      if (kind === "ac" && signingKey && !sameTag(response.headers.get("x-artifact-tag"), sign(signingKey, artifact, body))) {
        stats.unsigned++;
        continue;
      }
      return body;
    }
    return null;
  }

  async function put(kind: string, hash: string, body: Buffer) {
    const artifact = artifactId(write, kind, hash);
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
    };
    if (signingKey) headers["x-artifact-tag"] = sign(signingKey, artifact, body);
    const response = await call("PUT", artifact, { body, headers });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`Vercel cache write failed: HTTP ${response.status}`);
  }

  const server = http.createServer(async (req, res) => {
    const match = /^\/(ac|cas)\/([a-f0-9]{64})$/.exec(req.url!);
    if (!match) return res.writeHead(400).end();
    const [, kind, hash] = match as unknown as [string, string, string];
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        const body = await get(kind, hash);
        if (!body) {
          stats.misses++;
          return res.writeHead(404).end();
        }
        stats.hits++;
        res.writeHead(200, { "Content-Length": body.length });
        return res.end(req.method === "GET" ? body : undefined);
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        if (!upload) return res.writeHead(403).end();
        await put(kind, hash, body);
        stats.uploads++;
        return res.writeHead(200).end();
      }
      res.writeHead(405).end();
    } catch (error) {
      stats.errors++;
      res.writeHead(502).end(String((error as Error).message));
    }
  });
  return { server, stats };
}

export { createCacheProxy, artifactId, sign };

if (import.meta.main) {
  const { VERCEL_TOKEN: token, BOBR_VERCEL_TEAM: teamId } = process.env;
  // In GitHub Actions, notices and warnings show on the run page, outside the logs.
  const actions = process.env.GITHUB_ACTIONS === "true";
  const unavailable = (reason: string) => {
    // A rejected or expired token should be visible without reading the logs.
    console.error(`${actions ? "::warning title=Vercel cache::" : ""}Vercel's Remote Cache is unavailable: ${reason}`);
    process.exit(1);
  };
  (async () => {
    // Without access to the team's cache, Bazel should build locally instead.
    const url = new URL("/v8/artifacts/status", API);
    url.searchParams.set("teamId", teamId!);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const status = response.ok ? ((await response.json()) as { status: string }).status : `HTTP ${response.status}`;
    if (status !== "enabled") unavailable(status);
    const { server, stats } = createCacheProxy({
      token: token!,
      teamId: teamId!,
      signingKey: process.env.BAZEL_CACHE_SIGNING_KEY || undefined,
      upload: process.env.BAZEL_REMOTE_UPLOAD === "1",
    });
    server.listen(0, "127.0.0.1", () => console.log((server.address() as AddressInfo).port));
    const stop = () => {
      // Bazel's output ends in a color reset without a newline, so start a new line.
      const notice = actions ? "\n::notice title=Vercel cache::" : "";
      console.error(
        notice +
          `Vercel cache: ${stats.hits} hits, ${stats.misses} misses, ${stats.uploads} uploads` +
          (stats.unsigned ? `, ${stats.unsigned} unsigned results ignored` : "") +
          (stats.errors ? `, ${stats.errors} errors` : ""),
      );
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  })().catch((error) => unavailable(error.message));
}
