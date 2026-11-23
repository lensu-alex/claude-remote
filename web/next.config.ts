import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The home folder has no lockfile of its own; pin the root so Next doesn't guess.
  turbopack: { root: __dirname },
  // The floating dev badge covers the composer on a phone-sized screen.
  devIndicators: false,
  // Lets an open copy of the app notice a newer deployment and reload into it (lib/version.ts).
  // Both must be the same every time this file is read during one build, so the time comes
  // from the build script in package.json rather than from a clock here.
  env: {
    BUILD_ID: process.env.VERCEL_DEPLOYMENT_ID ?? "local",
    BUILD_TIME: process.env.BUILD_TIME ?? "",
  },
  async headers() {
    return [
      {
        // The service worker must never be served stale, or push fixes don't reach the phone.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
