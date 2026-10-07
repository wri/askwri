import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Crawler / AI-indexer exclusion controls.
 *
 * AskWRI must not be indexed by search engines or absorbed into LLM training
 * or retrieval corpora. Three layers, each covering a different failure mode:
 *
 *   1. /robots.txt (src/app/robots.ts) — convention for well-behaved crawlers,
 *      with AI bots named explicitly.
 *   2. X-Robots-Tag header (next.config.js) — covers fetchers that ignore
 *      robots.txt but honor headers, and works for every path including APIs.
 *   3. Site-wide `robots` metadata (src/app/layout.tsx) — covers clients that
 *      render HTML but ignore response headers.
 *   4. /llms.txt (public/llms.txt) — the llms.txt convention: a plain-language
 *      statement of what the site is and that it must not be indexed or
 *      ingested, for LLM agents that read it before crawling.
 *
 * These tests pin all four so a refactor cannot silently drop one.
 */

const readSrc = (...parts: string[]) =>
  readFileSync(join(__dirname, '..', ...parts), 'utf8')

describe('crawler and AI-indexer exclusion controls', () => {
  describe('robots.txt route', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const robots = require('../app/robots.ts') as {
      default: () => {
        rules: Array<{
          userAgent: string | string[]
          disallow: string
          noarchive?: boolean
          noimageindex?: boolean
        }>
      }
    }

    it('disallows everything for the wildcard agent', () => {
      const wildcard = robots.default().rules.find((r) => r.userAgent === '*')
      expect(wildcard).toBeDefined()
      expect(wildcard?.disallow).toBe('/')
    })

    it('names the major AI/LLM crawlers explicitly', () => {
      const agents = robots.default().rules.map((r) => r.userAgent)
      for (const bot of [
        'GPTBot',
        'OAI-SearchBot',
        'ClaudeBot',
        'Google-Extended',
        'CCBot',
        'PerplexityBot',
        'Bytespider',
        'Amazonbot',
        'Applebot-Extended',
        'Meta-ExternalAgent',
      ]) {
        expect(agents).toContain(bot)
      }
    })

    it('blocks every named agent from the whole site', () => {
      for (const rule of robots.default().rules) {
        expect(rule.disallow).toBe('/')
      }
    })
  })

  describe('X-Robots-Tag header', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nextConfig = require('../../next.config.js')

    it('applies noindex/nofollow to every path', async () => {
      const header = (await nextConfig.headers())
        .find((entry: { source: string }) => entry.source === '/:path*')
        .headers.find((h: { key: string }) => h.key === 'X-Robots-Tag')
      expect(header).toBeDefined()
      expect(header.value).toContain('noindex')
      expect(header.value).toContain('nofollow')
    })

    it('stays alongside the existing security headers', async () => {
      const entry = (await nextConfig.headers()).find(
        (e: { source: string }) => e.source === '/:path*',
      )
      const keys = entry.headers.map((h: { key: string }) => h.key)
      expect(keys).toEqual(
        expect.arrayContaining([
          'X-Frame-Options',
          'X-Content-Type-Options',
          'X-XSS-Protection',
          'X-Robots-Tag',
        ]),
      )
    })
  })

  describe('llms.txt', () => {
    const llmsTxt = readFileSync(
      join(__dirname, '..', '..', 'public', 'llms.txt'),
      'utf8',
    )

    it('exists and states the no-index policy', () => {
      expect(llmsTxt).toContain('# AskWRI')
      expect(llmsTxt).toMatch(/must not be indexed/i)
      expect(llmsTxt).toMatch(/X-Robots-Tag/i)
    })

    it('does not leak secrets or internal addresses', () => {
      // The MCP key is env-only and must never appear in a served file.
      expect(llmsTxt).not.toMatch(/MCP_SHARED_KEY\s*=|sk-[A-Za-z0-9]{20,}/)
      // No concrete hostnames: the file must stay environment-agnostic.
      expect(llmsTxt).not.toMatch(/https:\/\/[a-z0-9.-]+\.(org|com|io|dev)\//)
    })
  })

  describe('site-wide metadata', () => {
    it('layout.tsx sets robots index/follow false', () => {
      const layout = readSrc('app', 'layout.tsx')
      expect(layout).toMatch(/robots:\s*\{/)
      expect(layout).toMatch(/index:\s*false/)
      expect(layout).toMatch(/follow:\s*false/)
    })

    it('experts pages keep their own noindex meta', () => {
      for (const page of [
        'app/experts/page.tsx',
        'app/experts/help/page.tsx',
      ]) {
        expect(readSrc(...page.split('/'))).toMatch(
          /<meta name='robots' content='noindex' \/>/,
        )
      }
    })
  })
})
