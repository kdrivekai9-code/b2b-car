// next.config.js — CommonJS (repo root package.json is "type": "commonjs").
// Stage 1 coexistence: Next.js only owns paths that have a matching file under app/.
// Everything else (all not-yet-migrated Express routes) falls through to the
// existing Express app, unchanged, via the "fallback" rewrite below.
/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        { source: '/:path*', destination: '/api/index' },
      ],
    };
  },
};

module.exports = nextConfig;
