const fs = require("node:fs");
const path = require("node:path");

module.exports = function checkArtifact(directory) {
  const root = fs.realpathSync(directory);
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.json")));
  if (config.version !== 3)
    throw new Error("Expected Vercel Build Output API v3");
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (
          !target.startsWith(root + path.sep) ||
          path.isAbsolute(fs.readlinkSync(file))
        ) {
          throw new Error(`Artifact symlink escapes its output: ${file}`);
        }
      } else if (entry.isDirectory()) visit(file);
      else if (entry.name === ".vc-config.json") {
        const metadata = JSON.parse(fs.readFileSync(file));
        if (metadata.filePathMap)
          throw new Error(`Function still references build inputs: ${file}`);
        if (!fs.existsSync(path.join(dir, metadata.handler)))
          throw new Error(`Missing function handler: ${file}`);
      }
    }
  }
  visit(root);
};
