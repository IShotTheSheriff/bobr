import { execSync } from "node:child_process";

// ------------------------------------------------------------------------------
// CI Affected Workflow Script
// ------------------------------------------------------------------------------
// This script orchestrates the "Smart CI" process using Nx's affected
// capabilities. It ensures we only build and test what has actually changed.
//
// Workflow:
// 1. Identify affected packages by comparing against a base git reference.
// 2. Build only the affected packages and their dependencies.
// 3. Calculate build hashes to further optimize (e.g. skip e2e if binary identical).
// 4. Run E2E tests only for the affected apps.
// ------------------------------------------------------------------------------

// Determine the base commit/branch to compare against.
// - In CI (GitHub Actions), this is passed via the NX_BASE env var.
// - Locally, it defaults to "origin/main".
const BASE = process.env.NX_BASE || "origin/main";

console.log("=================================================================");
console.log("Starting Smart CI Workflow");
console.log(`Comparing against base: ${BASE}`);
console.log("=================================================================");

try {
  // 1. Build Affected Packages
  console.log("\nStep 1: Building affected packages...");
  execSync(`npx nx affected -t build --base=${BASE}`, { stdio: "inherit" });

  // 2. Calculate Build Hashes
  // Runs a custom script that hashes the build outputs (.next folders).
  // This is used by the e2e:test task to decide if it can skip execution based on
  // whether the actual build artifact changed (not just the source code).
  console.log("\nStep 2: Calculating build hashes...");
  execSync("npx tsx scripts/hash-build.ts", { stdio: "inherit" });

  // 3. Run E2E Tests
  // Uses the same filter to ensuring we only run tests that are related to the changes.
  console.log("\nStep 3: Running E2E tests for affected apps...");
  execSync(`npx nx affected -t e2e:test --base=${BASE}`, { stdio: "inherit" });

  console.log("\nCI Workflow completed successfully!");
} catch (error) {
  console.error("\nCI Workflow failed!");
  process.exit(1);
}
