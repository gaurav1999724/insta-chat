import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker (Phase 14, spec §71): a self-contained `.next/standalone` build
  // (its own minimal `server.js` + only the production `node_modules` it
  // actually needs) is what makes the production Dockerfile's runtime
  // stage small, instead of copying the entire `node_modules` tree.
  output: "standalone",

  // spec §87 security review: baseline security headers applied to every
  // response. Deliberately no `Content-Security-Policy` yet — this app
  // renders Instagram profile pictures from a Meta-controlled CDN domain
  // that isn't pinned down anywhere in code (spec-driven, not hardcoded),
  // so a real CSP `img-src` needs verifying against actual Instagram CDN
  // responses first (this dev environment has never loaded a real one —
  // see PROJECT_ANALYSIS.md §10). Documented as a deliberate gap in
  // SECURITY_REVIEW.md rather than shipping a CSP that would silently
  // break profile pictures.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
