// Bundle one test file with the code it reaches, so Node runs TypeScript and
// JSX that import without file extensions.
import esbuild from "esbuild";

const [entry, outfile] = process.argv.slice(2);
esbuild.buildSync({
  entryPoints: [entry!],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  jsx: "automatic",
  // sideEffects:false and PURE comments must not hide code a test would run.
  ignoreAnnotations: true,
  minifyWhitespace: true,
  legalComments: "none",
  logLevel: "warning",
});
