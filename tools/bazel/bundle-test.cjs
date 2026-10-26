// Bundle one test file with the code it reaches. Bazel keys the test result on
// this bundle, so edits to unreachable code or comments reuse the cached result.
const esbuild = require("esbuild");

const [entry, outfile] = process.argv.slice(2);
esbuild.buildSync({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  jsx: "automatic",
  // sideEffects:false and PURE comments must not hide code a test would run.
  ignoreAnnotations: true,
  // Drops comments and path markers, so the bundle changes only with code.
  minifyWhitespace: true,
  legalComments: "none",
  logLevel: "warning",
});
