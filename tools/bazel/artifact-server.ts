// A test adapter for this PoC's routes. Vercel owns routing in deployment.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import * as tar from "tar";
import checkArtifact from "./check-artifact.ts";

if (process.argv[2] === "--function") {
  const directory = process.argv[3]!;
  const config = JSON.parse(
    fs.readFileSync(path.join(directory, ".vc-config.json"), "utf8"),
  );
  // Vercel generates CommonJS handlers.
  const handler: http.RequestListener = createRequire(import.meta.url)(path.join(directory, config.handler));
  http
    .createServer((req, res) =>
      Promise.resolve<unknown>(handler(req, res)).catch((error) => {
        console.error(error);
        res.writeHead(500).end(String(error));
      }),
    )
    .listen(0, "127.0.0.1", function (this: http.Server) {
      process.send!((this.address() as AddressInfo).port);
    });
} else {
  const root = fs.mkdtempSync(path.join(process.argv[3]!, "artifact-"));
  tar.x({
    file: path.resolve(process.argv[2]!),
    cwd: root,
    sync: true,
  });
  checkArtifact(root);
  const children: ChildProcess[] = [];
  const start = (name: string) =>
    new Promise<number>((resolve, reject) => {
      const child = fork(
        import.meta.filename,
        ["--function", path.join(root, "functions", name + ".func")],
        {
          env: { ...process.env, NODE_ENV: "production" },
        },
      );
      children.push(child);
      child.once("message", (port) => resolve(port as number));
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Function exited: ${code}`)),
      );
    });
  Promise.all([start("index"), start("api/hello")])
    .then(([pages, api]) => {
      const types: Record<string, string> = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".png": "image/png",
      };
      http
        .createServer((req, res) => {
          const pathname = new URL(req.url!, "http://localhost").pathname;
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
              res.writeHead(response.statusCode!, response.headers);
              response.pipe(res);
            },
          );
          upstream.on("error", (error) =>
            res.writeHead(502).end(String(error)),
          );
          req.pipe(upstream);
        })
        .listen(0, "127.0.0.1", function (this: http.Server) {
          process.send!((this.address() as AddressInfo).port);
        });
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
  process.on("exit", () => children.forEach((child) => child.kill()));
  process.on("SIGTERM", () => process.exit(0));
}
