// Compare a live deployment with the tested archive it was deployed from.
// Vercel owns routing in deployment, so this catches routes, functions and
// static files that behave differently there than in the archive tests.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");

const ROUTES = ["/", "/demo", "/api/hello", "/bobr-missing-page"];

function serve(archive) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bobr-deployment-"));
  const server = fork(path.join(__dirname, "artifact-server.cjs"), [archive, temp], {
    execPath: process.env.JS_BINARY__NODE_BINARY || process.execPath,
    execArgv: [],
    env: { PATH: process.env.PATH, HOME: temp, NODE_ENV: "production" },
  });
  const close = () => {
    server.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  };
  return new Promise((resolve, reject) => {
    server.once("message", (port) =>
      resolve({ url: `http://127.0.0.1:${port}`, close }),
    );
    server.once("exit", (code) => reject(new Error(`Archive server exited: ${code}`)));
  });
}

async function get(base, route, headers = {}) {
  const response = await fetch(new URL(route, base), {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    type: response.headers.get("content-type") || "",
    location: response.headers.get("location") || "",
    body: await response.text(),
  };
}

// Vercel Authentication answers with a redirect to its login service, while
// other protection modes answer 401 or 403.
function requiresLogin({ status, location }) {
  if (status === 401 || status === 403) return true;
  if (status < 300 || status >= 400 || !location) return false;
  try {
    return /(^|\.)vercel\.com$/.test(new URL(location).hostname);
  } catch {
    return false;
  }
}

const title = (html) => html.match(/<title>([^<]*)<\/title>/)?.[1];

async function checkDeployment(archive, deployment, { bypass } = {}) {
  const headers = bypass ? { "x-vercel-protection-bypass": bypass } : {};
  const first = await get(deployment, "/", headers);
  if (requiresLogin(first) && !bypass)
    return {
      skipped:
        "The deployment requires Vercel Authentication. Set VERCEL_AUTOMATION_BYPASS_SECRET to check it.",
    };
  const tested = await serve(archive);
  try {
    const problems = [];
    let requests = 0;
    for (const route of ROUTES) {
      const [expected, actual] = await Promise.all([
        get(tested.url, route),
        get(deployment, route, headers),
      ]);
      requests++;
      if (actual.status !== expected.status)
        problems.push(`${route}: status ${actual.status}, the tested archive returns ${expected.status}`);
      else if (expected.type.includes("text/html")) {
        if (title(actual.body) !== title(expected.body))
          problems.push(`${route}: title ${JSON.stringify(title(actual.body))}, expected ${JSON.stringify(title(expected.body))}`);
      } else if (actual.body !== expected.body)
        problems.push(`${route}: body differs from the tested archive`);
    }
    const home = await get(tested.url, "/");
    const assets = [
      ...new Set(
        [...home.body.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]),
      ),
    ].slice(0, 5);
    if (!assets.length) problems.push("/: the tested page references no static assets");
    for (const asset of assets) {
      const actual = await get(deployment, asset, headers);
      requests++;
      if (actual.status !== 200) problems.push(`${asset}: status ${actual.status}`);
    }
    return { problems, requests };
  } finally {
    tested.close();
  }
}

module.exports = checkDeployment;
module.exports.serve = serve;
if (require.main === module) {
  const [archive, deployment] = process.argv.slice(2);
  checkDeployment(path.resolve(archive), deployment, {
    bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  })
    .then(({ skipped, problems, requests }) => {
      const line = skipped
        ? `Skipped the deployment check: ${skipped}`
        : problems.length
          ? `The deployment differs from the tested archive:\n${problems.join("\n")}`
          : `The deployment matches the tested archive on ${requests} requests.`;
      console.log(skipped ? `::notice::${line}` : line);
      if (process.env.GITHUB_STEP_SUMMARY)
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
      if (problems?.length) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
