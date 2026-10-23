import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.resolve("../.."),
  transpilePackages: ["@repo/ui"],
  // CI checks original TypeScript sources separately from the runtime build.
  typescript: { ignoreBuildErrors: true },
  // A fixed ID reduces output churn but does not make Next reproducible.
  generateBuildId: async () => process.env.BOBR_BUILD_ID || "bobr-static",
  ...(process.env.BOBR_UI_PROJECTION
    ? {
        webpack(config) {
          config.resolve.alias["@repo/ui"] = path.resolve(
            process.env.BOBR_UI_PROJECTION,
          );
          return config;
        },
      }
    : {}),
  experimental: {
    optimizePackageImports: ["@repo/ui"],
  },
};

export default nextConfig;
