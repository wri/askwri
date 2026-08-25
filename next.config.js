/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  experimental: {
    // Applies to paths matched by src/proxy.ts. /api/admin/intake is NO LONGER
    // one of them: it was excluded from the matcher precisely because matching
    // it made Next tee the whole upload into two in-memory PassThroughs, which
    // OOM-killed the 512MB qa task on a 79MB PDF. So this value is no longer
    // sized for, or coupled to, the intake cap (MAX_FILE_BYTES).
    //
    // It was originally raised 10mb -> 55mb -> 105mb to stop the tee from
    // truncating large uploads (issue #310). That reason is gone. What remains
    // matched and body-carrying is /api/import-documents, which takes a JSON
    // row batch — far smaller than 105mb.
    //
    // The cost is real and unchanged: the buffer is held IN MEMORY per
    // in-flight request, doubled by the tee. At 105mb a single large POST to a
    // matched route can still cost ~210MB. Lowering this toward the 10mb
    // default is the right follow-up, gated on confirming the largest real
    // /api/import-documents batch — not done here to keep the OOM hotfix
    // scoped.
    proxyClientMaxBodySize: '105mb',
  },
  poweredByHeader: false,
  optimizePackageImports: ['react-icons'],
  transpilePackages: ['jose'],

  // Environment variables that should be available at runtime
  env: {
    NEXT_PUBLIC_ENVIRONMENT:
      process.env.NEXT_PUBLIC_ENVIRONMENT || 'development',
  },

  // Headers for security
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
        ],
      },
    ]
  },
}

module.exports = nextConfig
