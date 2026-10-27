// Bazel never builds or tests a workspace package that has no BUILD.bazel, and
// CI would stay green without it. The root package globs the package.json of
// every such package and passes the paths here.
const path = require("node:path");

const HINTS = [
  [/^apps\//, "copy apps/web/BUILD.bazel"],
  [/^packages\/.+-e2e$/, "copy packages/web-e2e/BUILD.bazel and set app"],
  [/^packages\//, "call shared_package() like packages/ui/BUILD.bazel"],
];

const missing = process.argv.slice(2).filter(Boolean).map(path.dirname);
for (const dir of missing) {
  const [, hint] = HINTS.find(([pattern]) => pattern.test(dir));
  console.error(`${dir} has no BUILD.bazel, so Bazel skips it. To add one, ${hint}.`);
}
process.exit(missing.length ? 1 : 0);
