/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  experimental: {
    // The auth middleware (src/proxy.ts) buffers request bodies; the default
    // 10MB cap silently truncates larger uploads, corrupting the multipart
    // body before /api/admin/intake can read it (issue #310: every PDF over
    // 10MB failed with "internal error"). Intake allows 100MB PDFs
    // (MAX_FILE_BYTES); this is sized for one max-size PDF plus multipart
    // overhead — the upload client sends one file per request. MUST stay above
    // MAX_FILE_BYTES: raise them together, never one alone.
    //
    // Cost of this size, recorded because it is the reason not to go higher:
    // the buffer is held IN MEMORY per in-flight request, against a 512MB qa
    // task (ecs.tf). Two concurrent 100MB uploads is ~200MB of buffer on top of
    // the app's own footprint — close enough to the limit that a third would
    // risk an OOM kill. Raised from 55mb on 2026-08-05 alongside the parse-side
    // Ghostscript shrink, which is what makes >50MB files parseable at all.
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
