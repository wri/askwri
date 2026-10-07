import type { MetadataRoute } from 'next'

/**
 * Keep every crawler and AI/LLM indexer out of AskWRI.
 *
 * `Disallow: /` blocks the well-behaved crawlers; the explicit agent list
 * covers the AI training/retrieval bots that ignore blanket rules or that
 * operators want to see named (GPTBot, ClaudeBot, Google-Extended, CCBot,
 * PerplexityBot, Bytespider, Amazonbot, Applebot-Extended, Meta-ExternalAgent,
 * Diffbot, and the common SEO scrapers).
 *
 * robots.txt only speaks allow/disallow/crawl-delay — the richer directives
 * (noarchive, noimageindex, nosnippet) are carried instead by the
 * `X-Robots-Tag` header in next.config.js and the site-wide `robots` metadata
 * in layout.tsx, which is where crawlers that parse HTML or headers read them.
 *
 * This is a convention, not enforcement: anything that ignores robots.txt
 * (or fetches raw URLs directly) is stopped by those two layers.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: '/',
      },
      // AI / LLM crawlers and model trainers, named explicitly. Several of
      // these are known to not honor a blanket `User-agent: *` block, and
      // operators grep logs for these names.
      ...[
        'GPTBot',
        'OAI-SearchBot',
        'ChatGPT-User',
        'ClaudeBot',
        'Claude-Web',
        'Claude-SearchBot',
        'anthropic-ai',
        'Google-Extended',
        'CCBot',
        'PerplexityBot',
        'Perplexity-User',
        'Bytespider',
        'Amazonbot',
        'Applebot-Extended',
        'Meta-ExternalAgent',
        'Meta-ExternalFetcher',
        'Diffbot',
        'PetalBot',
        'YouBot',
        'cohere-ai',
        'SemrushBot',
        'AhrefsBot',
        'MJ12bot',
        'DotBot',
        'Barkrowler',
        'DataForSeoBot',
        'SerpstatBot',
      ].map((userAgent) => ({
        userAgent,
        disallow: '/',
      })),
    ],
  }
}
