/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  experimental: {
    // The auth middleware (src/proxy.ts) buffers request bodies; the default
    // 10MB cap silently truncates larger uploads, corrupting the multipart
    // body before /api/admin/intake can read it (issue #310: every PDF over
    // 10MB failed with "internal error"). Intake allows 100MB PDFs
    // (MAX_FILE_BYTES); raising this buffers more per request in memory, so
    // it is sized for one max-size PDF plus multipart overhead — the upload
    // client sends one file per request. Buffering the full 20-file batch
    // cap in one request would need ~2GB and OOM the 512MB qa task.
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
