import type { NextConfig } from "next";

// The browser calls /api/* on this site and the Next server forwards it to the
// backend, so only the frontend needs a public port. Read at build time.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8001";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Big drawings can take a while to analyze (default is 30 s)
    proxyTimeout: 300_000,
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
};

export default nextConfig;
