// Run after updating Playwright. Browser versions and hashes are generated here.
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { createHash } = require("node:crypto");
const test = require.resolve("@playwright/test", {
  paths: [path.resolve("packages/web-e2e")],
});
const playwright = require.resolve("playwright", {
  paths: [path.dirname(test)],
});
const core = require.resolve("playwright-core/package.json", {
  paths: [path.dirname(playwright)],
});
const browsers = JSON.parse(
  fs.readFileSync(path.join(path.dirname(core), "browsers.json")),
);
const version = browsers.browsers.find(
  (browser) => browser.name === "chromium-headless-shell",
).browserVersion;
function digest(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          return digest(new URL(response.headers.location, url).href).then(
            resolve,
            reject,
          );
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`Download returned ${response.statusCode}`));
        }
        const hash = createHash("sha256");
        response.on("data", (chunk) => hash.update(chunk));
        response.on("end", () => resolve(hash.digest("hex")));
        response.on("error", reject);
      })
      .on("error", reject);
  });
}
(async () => {
  const pins = { version, sha256: {} };
  for (const platform of ["mac-arm64", "linux64"]) {
    pins.sha256[platform] = await digest(
      `https://cdn.playwright.dev/builds/cft/${version}/${platform}/chrome-headless-shell-${platform}.zip`,
    );
    console.log(`Pinned Chromium ${version} for ${platform}`);
  }
  fs.writeFileSync(
    "tools/bazel/chromium-pins.json",
    JSON.stringify(pins, null, 2) + "\n",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
