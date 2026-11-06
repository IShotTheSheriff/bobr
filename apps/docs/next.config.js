import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.resolve("../.."),
  transpilePackages: ["@repo/ui"],
  // CI checks original TypeScript sources separately from the runtime build.
  typescript: { ignoreBuildErrors: true },
  // A fixed ID reduces output churn but does not make Next reproducible.
  generateBuildId: async () => process.env.BOBR_BUILD_ID || "bobr-static",
  experimental: {
    optimizePackageImports: ["@repo/ui"],
  },
  // The equivalence check compares two builds made in different Bazel
  // sandboxes. Path-based module ids keep the sandbox path out of them.
  ...(process.env.BOBR_NAMED_IDS
    ? {
        webpack(config) {
          config.optimization.moduleIds = "named";
          config.optimization.chunkIds = "named";
          return config;
        },
      }
    : {}),
};

export default nextConfig;
