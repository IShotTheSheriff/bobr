// Lint one package with its own ESLint config. Any warning fails the check.
const path = require("node:path");

const dir = path.resolve(process.argv[2]);
const { ESLint } = require(require.resolve("eslint", { paths: [dir] }));

(async () => {
  const eslint = new ESLint({ cwd: dir });
  const results = await eslint.lintFiles(["."]);
  const formatter = await eslint.loadFormatter("stylish");
  const report = await formatter.format(results);
  if (report) console.log(report);
  if (results.some((result) => result.errorCount || result.warningCount))
    process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
