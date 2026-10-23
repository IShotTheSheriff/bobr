import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.BOBR_ARTIFACT_URL
    ? [["list"]]
    : [["html", { open: "never" }], ["list"]],
  outputDir: process.env.TEST_UNDECLARED_OUTPUTS_DIR || "test-results",
  maxFailures: process.env.CI ? 1 : 0,
  use: {
    baseURL:
      process.env.BOBR_ARTIFACT_URL ||
      process.env.NEXT_PUBLIC_BOBR_WEB_URL ||
      "http://localhost:3000",
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.BOBR_CHROMIUM },
  },
  webServer: process.env.BOBR_ARTIFACT_URL
    ? undefined
    : {
        command: process.env.CI
          ? "cd ../../apps/web && pnpm run start --port 3000"
          : "cd ../../apps/web && pnpm run dev",
        url: process.env.NEXT_PUBLIC_BOBR_WEB_URL || "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        stdout: "ignore",
        stderr: "pipe",
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
