const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const tar = require("tar");
const checkDeployment = require("./check-deployment.cjs");

// A minimal Build Output API v3 archive with the routes the check requests.
function archive(t, greeting) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    const target = path.join(root, "output", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const handler = (name, source) => {
    write(
      `functions/${name}.func/.vc-config.json`,
      JSON.stringify({ handler: "index.js", runtime: "nodejs24.x", launcherType: "Nodejs" }),
    );
    write(`functions/${name}.func/index.js`, source);
  };
  write("config.json", JSON.stringify({ version: 3 }));
  handler(
    "index",
    `module.exports = (req, res) => {
      const page = { "/": "Home", "/demo": "Demo" }[new URL(req.url, "http://x").pathname];
      res.statusCode = page ? 200 : 404;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<title>' + (page || "Missing") + '</title><script src="/_next/static/app.js"></script>');
    };`,
  );
  handler(
    "api/hello",
    `module.exports = (req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(${JSON.stringify(greeting)});
    };`,
  );
  write("static/_next/static/app.js", "console.log(1);\n");
  const file = path.join(root, "output.tar");
  tar.c({ cwd: path.join(root, "output"), file, sync: true, portable: true }, ["."]);
  return file;
}

async function deployed(t, file) {
  const server = await checkDeployment.serve(file);
  t.after(server.close);
  return server.url;
}

// Vercel Authentication redirects to its login unless the bypass header matches.
function protect(t, target, secret, denied = { location: "https://vercel.com/sso-api?url=x" }) {
  const server = http.createServer((req, res) => {
    if (req.headers["x-vercel-protection-bypass"] !== secret)
      return res.writeHead(denied.location ? 302 : 401, denied).end();
    const upstream = http.request(
      new URL(req.url, target),
      { method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  t.after(() => server.close());
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)),
  );
}

test("a deployment of the tested archive matches it", async (t) => {
  const file = archive(t, "hello web");
  const result = await checkDeployment(file, await deployed(t, file));
  assert.deepEqual(result, { problems: [], requests: 5 });
});

test("a deployment that serves different content fails", async (t) => {
  const result = await checkDeployment(
    archive(t, "hello web"),
    await deployed(t, archive(t, "hello docs!")),
  );
  assert.deepEqual(result.problems, ["/api/hello: body differs from the tested archive"]);
});

for (const [name, denied] of [
  ["a redirect to Vercel's login", undefined],
  ["401", {}],
]) {
  test(`a protected deployment answering ${name} is skipped without a bypass secret`, async (t) => {
    const file = archive(t, "hello web");
    const url = await protect(t, await deployed(t, file), "secret", denied);
    const result = await checkDeployment(file, url);
    assert.match(result.skipped, /automation bypass secret/);
  });
}

test("the bypass secret reaches a protected deployment", async (t) => {
  const file = archive(t, "hello web");
  const url = await protect(t, await deployed(t, file), "secret");
  const result = await checkDeployment(file, url, { bypass: "secret" });
  assert.deepEqual(result, { problems: [], requests: 5 });
});
