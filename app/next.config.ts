import type { NextConfig } from "next";

/** Conservative response headers. No strict CSP: Privy's sign-in dialog loads its own iframe and scripts, and breaking login costs more than it protects. */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" }, // nobody may frame Receipts (clickjacking); Privy's own iframe is framed BY us, which is unaffected
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Dev/test only: when API_PROXY is set (e.g. a local build checked in a browser), forward /api to a deployed instance
  // that holds the Redis credentials. Unset in production.
  async rewrites() {
    return process.env.API_PROXY
      ? { beforeFiles: [{ source: "/api/:path*", destination: `${process.env.API_PROXY}/api/:path*` }], afterFiles: [], fallback: [] }
      : [];
  },
};

export default nextConfig;
