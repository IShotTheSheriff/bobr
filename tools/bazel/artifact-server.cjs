// A test adapter for this PoC's routes. Vercel owns routing in deployment.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { fork } = require("node:child_process");

if (process.argv[2] === "--function") {
  const directory = process.argv[3];
  const config = JSON.parse(
    fs.readFileSync(path.join(directory, ".vc-config.json")),
  );
  const handler = require(path.join(directory, config.handler));
  http
    .createServer((req, res) =>
      Promise.resolve(handler(req, res)).catch((error) => {
        console.error(error);
        res.writeHead(500).end(String(error));
      }),
    )
    .listen(0, "127.0.0.1", function () {
      process.send(this.address().port);
    });
} else {
  const root = fs.mkdtempSync(path.join(process.argv[3], "artifact-"));
  require("tar").x({
    file: path.resolve(process.argv[2]),
    cwd: root,
    sync: true,
  });
  require("./check-artifact.cjs")(root);
  const children = [];
  const start = (name) =>
    new Promise((resolve, reject) => {
      const child = fork(
        __filename,
        ["--function", path.join(root, "functions", name + ".func")],
        {
          env: { ...process.env, NODE_ENV: "production" },
        },
      );
      children.push(child);
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Function exited: ${code}`)),
      );
    });
  Promise.all([start("index"), start("api/hello")])
    .then(([pages, api]) => {
      const types = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".png": "image/png",
      };
      http
        .createServer((req, res) => {
          const pathname = new URL(req.url, "http://localhost").pathname;
          const file = path.resolve(
            root,
            "static",
            "." + decodeURIComponent(pathname),
          );
          if (
            file.startsWith(path.join(root, "static") + path.sep) &&
            fs.existsSync(file) &&
            fs.statSync(file).isFile()
          ) {
            res.setHeader(
              "content-type",
              types[path.extname(file)] || "application/octet-stream",
            );
            fs.createReadStream(file).pipe(res);
            return;
          }
          const upstream = http.request(
            {
              hostname: "127.0.0.1",
              port: pathname === "/api/hello" ? api : pages,
              path: req.url,
              method: req.method,
              headers: req.headers,
            },
            (response) => {
              res.writeHead(response.statusCode, response.headers);
              response.pipe(res);
            },
          );
          upstream.on("error", (error) =>
            res.writeHead(502).end(String(error)),
          );
          req.pipe(upstream);
        })
        .listen(0, "127.0.0.1", function () {
          process.send(this.address().port);
        });
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
  process.on("exit", () => children.forEach((child) => child.kill()));
  process.on("SIGTERM", () => process.exit(0));
}
