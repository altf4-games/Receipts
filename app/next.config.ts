import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev/test only: when API_PROXY is set (e.g. a local build checked in a browser), forward /api to a deployed instance
  // that holds the Redis credentials. Unset in production.
  async rewrites() {
    return process.env.API_PROXY ? [{ source: "/api/:path*", destination: `${process.env.API_PROXY}/api/:path*` }] : [];
  },
};

export default nextConfig;
