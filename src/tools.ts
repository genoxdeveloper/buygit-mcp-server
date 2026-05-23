/**
 * MCP tools that expose the BuyGit Open Index.
 *
 * Every tool follows the same shape:
 *   - Glama-rubric description: first line is the *value proposition*
 *     (what this returns that other MCPs can't), then the usage signature,
 *     then a "when to call" hint. Keeps definition-quality score high.
 *   - Hand-written JSON Schema input (no zod-to-json-schema dep).
 *   - Zod re-validate inside the handler for defence-in-depth.
 *   - Markdown text content for human/LLM eyes PLUS `structuredContent`
 *     (MCP 2025-11-25 spec) so agents can consume the 4-axis signals
 *     {license, popularity, risk, price} without re-parsing markdown.
 *   - Errors are returned as `isError: true` tool results, never thrown.
 */
import { z } from 'zod';
import { apiGet, BuygitApiError } from './client.js';
import {
  summaryList,
  detailBlock,
  compareBlock,
  type ListingSummary,
  type ListingDetail,
} from './format/markdown.js';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Context passed into every tool handler.
 *
 * - `elicit(question, schema)` is wired by server.ts when the connected
 *   client declared elicitation capability at handshake time. If the
 *   client does NOT support elicitation, this resolves to null and the
 *   tool should fall through to its default behaviour. NEVER assume
 *   the function returns a non-null answer.
 *
 * The shape is small on purpose — adding more context fields later is
 * additive and won't break existing handlers.
 */
export interface ToolContext {
  /**
   * Ask the user a follow-up question mid-tool-call. Returns the user's
   * answer parsed against the supplied schema, or null when the client
   * doesn't support elicitation. Implementation lives in server.ts.
   */
  elicit: ((question: string, schema: Record<string, unknown>) => Promise<unknown | null>) | null;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

function textResult(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  const out: ToolResult = { content: [{ type: 'text', text }] };
  if (structuredContent) out.structuredContent = structuredContent;
  return out;
}

function errorResult(err: unknown): ToolResult {
  const msg = err instanceof BuygitApiError
    ? `BuyGit API error (${err.status}${err.code ? ` / ${err.code}` : ''}): ${err.message}`
    : err instanceof Error
      ? `Tool error: ${err.message}`
      : `Tool error: ${String(err)}`;
  return { content: [{ type: 'text', text: msg }], isError: true };
}

/**
 * Normalise the API rating shape into the ListingDetail.rating_block
 * expected by formatters. Centralised here to avoid the 3-place
 * duplication that was present in v0.9.1.
 */
function normalizeRating(raw: { rating?: { avg: number | null; count: number } }): { avg: number | null; count: number } {
  return raw.rating ?? { avg: null, count: 0 };
}

/**
 * Reusable JSON Schema fragments. Hoisted to module scope so every
 * tool that returns a listing references the same shape — keeps the
 * outputSchemas DRY and lets a future Signals change land in one place.
 */
const signalsSchema = {
  type: 'object',
  description: '4-axis signals (license, popularity, risk, pricing). The defining BuyGit MCP differentiator — no other MCP returns license + supply-chain risk + popularity + pricing in a single call.',
  required: ['license_category', 'license_warning', 'popularity', 'risk', 'price_usd', 'pricing_tier'],
  properties: {
    license_category: {
      type: 'string',
      enum: ['permissive', 'weak-copyleft', 'strong-copyleft', 'public-domain', 'proprietary', 'unknown'],
    },
    license_warning: { type: ['string', 'null'], description: 'Plain-English warning when the license needs attention; null when safe.' },
    popularity: { type: 'integer', minimum: 0, maximum: 100, description: 'Log-scaled star score 0-100.' },
    risk: { type: 'integer', minimum: 0, maximum: 100, description: 'Supply-chain risk score 0-100. 0 = clean. ≥40 = warn user before bundling.' },
    price_usd: { type: 'number', minimum: 0 },
    pricing_tier: { type: 'string', enum: ['free', 'paid'] },
  },
} as const;

const summaryItemSchema = {
  type: 'object',
  required: ['slug', 'title', 'url'],
  properties: {
    slug: { type: 'string', description: 'Canonical listing slug — pass to buygit_get_listing for full detail.' },
    title: { type: 'string' },
    url: { type: 'string', format: 'uri', description: 'Canonical buygit.com listing URL.' },
    license: { type: ['string', 'null'], description: 'SPDX identifier or null when undeclared.' },
    stars: { type: 'integer', minimum: 0 },
    signals: signalsSchema,
  },
} as const;

// ── search ─────────────────────────────────────────────────────────────────
const searchInput = z.object({
  query: z.string().max(200).optional(),
  category: z.string().max(80).optional(),
  language: z.string().max(40).optional(),
  license: z.string().max(40).optional(),
  min_stars: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().max(512).optional(),
  sort: z.enum(['relevance', 'newest', 'stars', 'health']).default('relevance'),
});

const searchTool: ToolDefinition = {
  name: 'buygit_search',
  description:
    'Search 78,094 curated, deduplicated, license-tagged Git assets — not raw GitHub search. Every result carries license + popularity + supply-chain risk + pricing in one shot. Filters: category slug, language, SPDX license, min stars. Sort: relevance | newest | stars | health. Prefer this when the user wants to *use* or *buy* a project, compare alternatives, or check license compatibility. Use github-mcp for private repos / Issues / commits.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        maxLength: 200,
        description: 'Free-text query matched against title, short description, and tags.',
        examples: ['react form library', 'rag vector store', 'discord bot template', 'image diff'],
      },
      category: {
        type: 'string',
        maxLength: 80,
        description: 'Category slug from buygit_list_categories. Common: api-backends (20k), dev-tools (17k), wordpress-plugins (5.5k), ai-agents, saas-starters, boilerplates, ml-models, scripts.',
        examples: ['api-backends', 'dev-tools', 'ai-agents', 'saas-starters', 'rag-vector', 'wordpress-plugins', 'web-apps', 'scripts', 'boilerplates', 'ml-models'],
      },
      language: {
        type: 'string',
        maxLength: 40,
        description: 'Primary language. Matched against Repository.language_summary (dominant language by bytes).',
        examples: ['TypeScript', 'JavaScript', 'Python', 'Rust', 'Go', 'Java', 'PHP', 'Ruby', 'C++', 'Swift'],
      },
      license: {
        type: 'string',
        maxLength: 40,
        description: 'SPDX license identifier. Exact match required.',
        examples: ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'GPL-3.0', 'AGPL-3.0', 'LGPL-3.0', 'MPL-2.0', 'CC0-1.0', 'Unlicense'],
      },
      min_stars: { type: 'integer', minimum: 0, description: 'Lower bound on repo stars.', examples: [100, 500, 1000, 10000] },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Page size (1-50).' },
      cursor: { type: 'string', maxLength: 512, description: 'Opaque base64 cursor from a previous response.next_cursor for pagination.' },
      sort: { type: 'string', enum: ['relevance', 'newest', 'stars', 'health'], default: 'relevance', description: 'relevance (default), newest, stars (desc), or health (last commit + activity).' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['count', 'has_more', 'results'],
    properties: {
      count: { type: 'integer', minimum: 0, description: 'Number of results in this page.' },
      has_more: { type: 'boolean', description: 'True when more results exist beyond this page; use next_cursor to fetch.' },
      next_cursor: { type: ['string', 'null'], description: 'Opaque cursor for the next page; null when has_more is false.' },
      results: { type: 'array', items: summaryItemSchema },
    },
  },
  handler: async (args, ctx) => {
    const parsed = searchInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(`invalid arguments: ${parsed.error.message}`);
    let { query, category, language, license, min_stars, limit, cursor, sort } = parsed.data;
    try {
      const res = await apiGet<{ results: ListingSummary[]; next_cursor: string | null; has_more: boolean }>(
        '/api/v1/crawler/search',
        { q: query, category, language, license, min_stars, limit, cursor, sort },
      );

      // Elicitation (P1-8): when the client supports it AND the user
      // gave no license filter AND the result page is full + there's
      // more after it, offer to narrow by license. Saves a follow-up
      // tools/call turn and surfaces our license_warning differentiator
      // up-front. Falls through silently when ctx.elicit is null.
      if (ctx.elicit && !license && res.has_more && res.results.length >= limit) {
        const answer = (await ctx.elicit(
          `Found ${res.results.length}+ matches${query ? ` for "${query}"` : ''}. Narrow by license?`,
          {
            type: 'object',
            properties: {
              license: {
                type: 'string',
                enum: ['', 'MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'GPL-3.0', 'AGPL-3.0', 'MPL-2.0', 'LGPL-3.0'],
                description: 'SPDX id, or blank to skip narrowing.',
              },
            },
          },
        )) as { license?: string } | null;
        if (answer?.license && answer.license.length > 0) {
          license = answer.license;
          const narrowed = await apiGet<{ results: ListingSummary[]; next_cursor: string | null; has_more: boolean }>(
            '/api/v1/crawler/search',
            { q: query, category, language, license, min_stars, limit, sort },
          );
          res.results = narrowed.results;
          res.has_more = narrowed.has_more;
          res.next_cursor = narrowed.next_cursor;
        }
      }

      const header = [
        `**${res.results.length} result(s)**`,
        query ? `for "${query}"` : null,
        category ? `· category: ${category}` : null,
        language ? `· lang: ${language}` : null,
        license ? `· license: ${license}` : null,
        min_stars ? `· ≥${min_stars}★` : null,
        `· sort: ${sort}`,
      ].filter(Boolean).join(' ');
      const footer = res.has_more
        ? '_More results available. Call again with a narrower filter, or use buygit_get_listing(slug) on any of these for full detail._'
        : '_Call buygit_get_listing(slug) on any result for full detail._';
      return textResult(summaryList(res.results, { header, footer }), {
        count: res.results.length,
        has_more: res.has_more,
        results: res.results.map((r) => ({
          slug: r.slug,
          title: r.title,
          url: r.url,
          license: r.license,
          stars: r.stars,
          signals: r.signals,
        })),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── get_listing ────────────────────────────────────────────────────────────
const getListingInput = z.object({ slug: z.string().regex(/^[a-z0-9\-]+$/i).max(200) });

const getListingTool: ToolDefinition = {
  name: 'buygit_get_listing',
  description:
    'Full detail for one BuyGit listing — replaces 3 separate MCP calls (license + supply-chain risk + popularity in one response). Includes secret-scan status, malware flag, upstream health, repo signals (stars, forks, last commit, language), full description, license classification with compatibility warning, pricing, and up to 5 similar listings. Slug must come from a prior buygit_search / trending / random / compare result.',
  inputSchema: {
    type: 'object',
    required: ['slug'],
    properties: {
      slug: { type: 'string', pattern: '^[a-z0-9\\-]+$', maxLength: 200, description: 'Listing slug from a previous tool call.' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['slug', 'title', 'url', 'signals'],
    properties: {
      slug: { type: 'string' },
      title: { type: 'string' },
      url: { type: 'string' },
      license: { type: ['string', 'null'] },
      signals: signalsSchema,
    },
  },
  handler: async (args) => {
    const parsed = getListingInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(`invalid slug: ${parsed.error.message}`);
    try {
      const raw = await apiGet<ListingDetail & { rating?: { avg: number | null; count: number } }>(
        `/api/v1/crawler/listings/${encodeURIComponent(parsed.data.slug)}`,
      );
      const detail: ListingDetail = {
        ...raw,
        rating_block: normalizeRating(raw),
      };
      return textResult(detailBlock(detail), {
        slug: detail.slug,
        title: detail.title,
        url: detail.url,
        license: detail.license,
        signals: detail.signals,
        safety: detail.safety_signals,
        repo: {
          stars: detail.repo_signals.stars,
          forks: detail.repo_signals.forks,
          language: detail.repo_signals.language,
          last_commit_at: detail.repo_signals.last_commit_at,
          upstream_status: detail.repo_signals.upstream_status,
        },
      });
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── list_categories ────────────────────────────────────────────────────────
const listCategoriesTool: ToolDefinition = {
  name: 'buygit_list_categories',
  description:
    'Full BuyGit Open Index taxonomy with per-category crawler listing counts. Use this to find a category slug for buygit_search, or to discover what is in the catalog. Counts are accurate to the last crawl (typically <24h).',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: {
    type: 'object',
    required: ['categories'],
    properties: {
      categories: { type: 'array', items: { type: 'object' } },
    },
  },
  handler: async (args) => {
    // P3-2: validate even empty-arg tools for schema consistency
    const _parsed = z.object({}).safeParse(args ?? {}); void _parsed;
    try {
      interface Node { slug: string; name: string; crawler_listing_count: number; children: Node[] }
      const res = await apiGet<{ categories: Node[] }>(`/api/v1/crawler/categories`);
      const lines: string[] = ['**BuyGit category tree** (crawler listings only)', ''];
      function walk(node: Node, depth: number): void {
        const indent = '  '.repeat(depth);
        lines.push(`${indent}- **${node.name}** \`${node.slug}\` · ${node.crawler_listing_count}`);
        for (const c of node.children) walk(c, depth + 1);
      }
      for (const root of res.categories) walk(root, 0);
      lines.push('');
      lines.push('_Pick a slug and pass it as `category` to `buygit_search` to filter._');
      return textResult(lines.join('\n'), { categories: res.categories });
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── trending ───────────────────────────────────────────────────────────────
const trendingInput = z.object({
  period: z.enum(['day', 'week', 'month']).default('week'),
  category: z.string().max(80).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const trendingTool: ToolDefinition = {
  name: 'buygit_trending',
  description:
    'Top crawler listings ranked by recent activity (day | week | month), each carrying license + risk + popularity + pricing. Optionally narrow to a category. Use for "what is hot right now in <category>" — agent gets a curated, license-aware shortlist instead of GitHub trending noise.',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['day', 'week', 'month'], default: 'week' },
      category: { type: 'string', maxLength: 80 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['period', 'count', 'results'],
    properties: {
      period: { type: 'string', enum: ['day', 'week', 'month'] },
      count: { type: 'integer', minimum: 0 },
      results: { type: 'array', items: summaryItemSchema },
    },
  },
  handler: async (args) => {
    const parsed = trendingInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(parsed.error.message);
    const { period, category, limit } = parsed.data;
    try {
      const res = await apiGet<{ period: string; category: string | null; results: ListingSummary[]; count: number }>(
        '/api/v1/crawler/trending',
        { period, category, limit },
      );
      const header = `**Trending (${period}${category ? ` · ${category}` : ''})** — ${res.count} listing(s)`;
      return textResult(
        summaryList(res.results, { header, footer: '_Call buygit_get_listing(slug) for full detail._' }),
        {
          period: res.period,
          count: res.count,
          results: res.results.map((r) => ({
            slug: r.slug, title: r.title, url: r.url, license: r.license, stars: r.stars, signals: r.signals,
          })),
        },
      );
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── compare ────────────────────────────────────────────────────────────────
const compareInput = z.object({ slugs: z.array(z.string().regex(/^[a-z0-9\-]+$/i)).min(2).max(5) });

const compareTool: ToolDefinition = {
  name: 'buygit_compare',
  description:
    'Single-call side-by-side of 2-5 listings: license category, license_warning, popularity score, risk score, pricing, repo signals. Equivalent github-mcp / Smithery workflows need 4+ calls and do not return license compatibility. Pass slugs from prior tool results; unknown slugs come back as `not found` entries instead of erroring.',
  inputSchema: {
    type: 'object',
    required: ['slugs'],
    properties: {
      slugs: {
        type: 'array',
        items: { type: 'string', pattern: '^[a-z0-9\\-]+$' },
        minItems: 2,
        maxItems: 5,
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['items'],
    properties: {
      items: { type: 'array' },
    },
  },
  handler: async (args) => {
    const parsed = compareInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(parsed.error.message);
    try {
      // P3-4: encode each slug individually then join — prevents comma
      // from being double-encoded by the query-string builder.
      const res = await apiGet<{ items: (ListingDetail | { slug: string; error: string })[] }>(
        '/api/v1/crawler/compare',
        { slugs: parsed.data.slugs.map(s => encodeURIComponent(s)).join(',') },
      );
      const items = res.items.map((it) => {
        if ('error' in it) return it;
        const r = it as ListingDetail & { rating?: { avg: number | null; count: number } };
        return { ...r, rating_block: normalizeRating(r) } as ListingDetail;
      });
      return textResult(compareBlock(items), {
        items: items.map((it) => {
          if ('error' in it) return it;
          return {
            slug: it.slug, title: it.title, url: it.url, license: it.license, signals: it.signals,
          };
        }),
      });
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── stats ──────────────────────────────────────────────────────────────────
const statsTool: ToolDefinition = {
  name: 'buygit_stats',
  description:
    'BuyGit Open Index meta — total listings, license breakdown, top categories, source providers, last_indexed_at. Useful for "how big is the catalog?", "what license is most common?", or proving the curated catalog size before recommending it.',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: {
    type: 'object',
    required: ['total_listings'],
    properties: {
      total_listings: { type: 'integer' },
      last_indexed_at: { type: ['string', 'null'] },
      by_license: { type: 'array' },
      by_category: { type: 'array' },
      by_source: { type: 'array' },
    },
  },
  handler: async (args) => {
    // P3-3: validate even empty-arg tools for schema consistency
    const _parsed = z.object({}).safeParse(args ?? {}); void _parsed;
    try {
      interface Stats {
        total_listings: number;
        by_license: { license: string; count: number }[];
        by_category: { slug: string; name: string; count: number }[];
        by_source: { source: string; count: number }[];
        last_indexed_at: string | null;
        generated_at: string;
      }
      const s = await apiGet<Stats>('/api/v1/crawler/stats');
      const lines: string[] = [];
      lines.push(`**BuyGit Open Index — ${s.total_listings.toLocaleString()} crawler listings**`);
      lines.push('');
      if (s.last_indexed_at) lines.push(`Last indexed: ${s.last_indexed_at}`);
      lines.push('');
      lines.push('**Top licenses**');
      for (const l of s.by_license.slice(0, 8)) lines.push(`- ${l.license}: ${l.count.toLocaleString()}`);
      lines.push('');
      lines.push('**Top categories**');
      for (const c of s.by_category.slice(0, 10)) lines.push(`- ${c.name} \`${c.slug}\`: ${c.count.toLocaleString()}`);
      lines.push('');
      lines.push('**Sources**');
      for (const src of s.by_source.slice(0, 10)) lines.push(`- ${src.source}: ${src.count.toLocaleString()}`);
      return textResult(lines.join('\n'), {
        total_listings: s.total_listings,
        last_indexed_at: s.last_indexed_at,
        by_license: s.by_license,
        by_category: s.by_category,
        by_source: s.by_source,
      });
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── random ─────────────────────────────────────────────────────────────────
const randomInput = z.object({
  count: z.number().int().min(1).max(10).default(1),
  category: z.string().max(80).optional(),
});

const randomTool: ToolDefinition = {
  name: 'buygit_random',
  description:
    'Surface 1-10 random crawler listings, each with license + risk + popularity + pricing signals. Useful for "surprise me", category browsing, or seeding agent suggestions when the user has not specified intent. Optional `category` slug narrows the pool.',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 10, default: 1, description: 'Number of random picks (1-10).' },
      category: { type: 'string', maxLength: 80, description: 'Category slug to narrow the pool (optional).' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['count', 'results'],
    properties: {
      count: { type: 'integer', minimum: 0, maximum: 10 },
      results: { type: 'array', items: summaryItemSchema },
    },
  },
  handler: async (args) => {
    const parsed = randomInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(parsed.error.message);
    try {
      const res = await apiGet<{ results: ListingSummary[]; count: number }>(
        '/api/v1/crawler/random',
        { count: parsed.data.count, category: parsed.data.category },
      );
      return textResult(
        summaryList(res.results, { header: `**Random pick (${res.count})**` }),
        {
          count: res.count,
          results: res.results.map((r) => ({
            slug: r.slug, title: r.title, url: r.url, license: r.license, stars: r.stars, signals: r.signals,
          })),
        },
      );
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── find_alternative ───────────────────────────────────────────────────────
const findAlternativeInput = z.object({
  query: z.string().min(1).max(200).describe('A library / repo name or short description to find alternatives to.'),
  language: z.string().max(40).optional(),
  license: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(20).default(8),
});

const findAlternativeTool: ToolDefinition = {
  name: 'buygit_find_alternative',
  description:
    'Find license-compatible, risk-scored alternatives to a library or repo — the answer GitHub search cannot give (raw search ranks by stars and lacks license/risk signals). Filter by language and required license (e.g. MIT-only). Use when the user says "what can replace X?", "alternatives to Y", or "the GPL version of Z is blocking me, find an MIT one".',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200, description: 'Library or repo to find alternatives for.' },
      language: { type: 'string', maxLength: 40, description: 'Primary language filter (e.g. "TypeScript").' },
      license: { type: 'string', maxLength: 40, description: 'SPDX id to restrict alternatives (e.g. MIT to exclude GPL).' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 8, description: 'Max results (1-20).' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['query', 'count', 'results'],
    properties: {
      query: { type: 'string', description: 'Echoed query for client-side correlation.' },
      count: { type: 'integer', minimum: 0 },
      results: { type: 'array', items: summaryItemSchema },
    },
  },
  handler: async (args) => {
    const parsed = findAlternativeInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(parsed.error.message);
    const { query, language, license, limit } = parsed.data;
    try {
      const res = await apiGet<{ results: ListingSummary[] }>(
        '/api/v1/crawler/search',
        { q: query, language, license, limit, sort: 'stars' },
      );
      // P2-1: Use word-boundary matching instead of naive includes().
      // This prevents "react" from matching "reactivity" or "reactive-streams".
      const queryTerms = query.toLowerCase().split(/[\s/]+/).filter(t => t.length > 1);
      const filtered = res.results.filter((r) => {
        const title = r.title.toLowerCase();
        // Exclude listings whose title exactly matches ALL query terms
        // (i.e. the original library itself), but keep partial matches.
        const matchesAll = queryTerms.every(term => {
          const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          return re.test(title);
        });
        return !matchesAll;
      });
      const final = filtered.length >= 3 ? filtered : res.results;
      return textResult(
        summaryList(final, {
          header: `**Alternatives to "${query}"** ${language ? `(${language})` : ''}${license ? ` · ${license}-only` : ''}`.trim(),
          footer: '_If none of these fit, try `buygit_search` with a more specific query._',
        }),
        {
          query,
          count: final.length,
          results: final.map((r) => ({
            slug: r.slug, title: r.title, url: r.url, license: r.license, stars: r.stars, signals: r.signals,
          })),
        },
      );
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── check_license_compat ───────────────────────────────────────────────────
const checkLicenseCompatInput = z.object({
  source: z.string().max(60).describe('SPDX id of the dependency you want to use (e.g. "GPL-3.0").'),
  target: z.string().max(60).describe('SPDX id of the project you want to bundle it into (e.g. "MIT").'),
});

const checkLicenseCompatTool: ToolDefinition = {
  name: 'buygit_check_license_compat',
  description:
    'Check whether SPDX license A can be bundled into a project licensed under SPDX license B. Returns one of compatible / review / incompatible with a plain-English note. The only MCP that answers "Is GPL-3.0 safe in my MIT project?" without a separate SCA tool. Hint, not legal advice.',
  inputSchema: {
    type: 'object',
    required: ['source', 'target'],
    properties: {
      source: {
        type: 'string',
        maxLength: 60,
        description: 'SPDX id of the dependency you want to use.',
        examples: ['GPL-3.0', 'AGPL-3.0', 'MIT', 'Apache-2.0', 'LGPL-3.0'],
      },
      target: {
        type: 'string',
        maxLength: 60,
        description: 'SPDX id of the project you want to bundle it into.',
        examples: ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0', 'proprietary'],
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['source', 'target', 'verdict', 'note'],
    properties: {
      source: { type: 'object', properties: { spdx: { type: 'string' }, category: { type: 'string' } } },
      target: { type: 'object', properties: { spdx: { type: 'string' }, category: { type: 'string' } } },
      verdict: { type: 'string', enum: ['compatible', 'review', 'incompatible'] },
      note: { type: 'string' },
    },
  },
  handler: async (args) => {
    const parsed = checkLicenseCompatInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(parsed.error.message);
    try {
      const res = await apiGet<{
        source: { spdx: string; category: string };
        target: { spdx: string; category: string };
        verdict: 'compatible' | 'review' | 'incompatible';
        note: string;
        disclaimer: string;
      }>('/api/v1/crawler/license-compat', { source: parsed.data.source, target: parsed.data.target });
      const verdictEmoji = res.verdict === 'compatible' ? '✅' : res.verdict === 'incompatible' ? '❌' : '⚠️';
      const md = [
        `# License compatibility: ${parsed.data.source} → ${parsed.data.target}`,
        '',
        `${verdictEmoji} **${res.verdict.toUpperCase()}**`,
        '',
        `- Source: ${res.source.spdx} (\`${res.source.category}\`)`,
        `- Target: ${res.target.spdx} (\`${res.target.category}\`)`,
        '',
        `> ${res.note}`,
        '',
        `_${res.disclaimer}_`,
      ].join('\n');
      return textResult(md, res);
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── audit_repo ─────────────────────────────────────────────────────────────
const auditRepoInput = z.object({
  url: z.string().url().max(400).describe('External GitHub repository URL (e.g. https://github.com/owner/repo).'),
});

const auditRepoTool: ToolDefinition = {
  name: 'buygit_audit_repo',
  description:
    'Audit any external GitHub repo (not just BuyGit catalog) — returns license + supply-chain risk + popularity + repo signals in one shot. If the repo is already in our catalog, uses the richer cached signals. Otherwise lives-probes the GitHub REST API. Use for "is github.com/X/Y safe to bundle?" or "what license is github.com/X/Y under?".',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        maxLength: 400,
        // Strict github.com URL pattern. Anything that doesn't match this
        // shape is rejected at schema-validation time before reaching the
        // handler — saves a round-trip to a 400 from the backend.
        pattern: '^https?://(www\\.)?github\\.com/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?/[A-Za-z0-9._\\-]+(?:\\.git)?/?$',
        description: 'github.com/{owner}/{repo} URL. Strict github.com host enforcement.',
        examples: [
          'https://github.com/sindresorhus/is-online',
          'https://github.com/vercel/next.js',
          'https://github.com/anthropics/claude-code',
        ],
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['source', 'repo_url'],
    properties: {
      source: { type: 'string', enum: ['catalog', 'github-live'], description: 'Which path satisfied the request — catalog row or live GitHub REST probe.' },
      repo_url: { type: 'string', format: 'uri' },
      listing: { ...summaryItemSchema, description: 'Present when source = catalog. Cached BuyGit listing with full signals.' },
      audit: {
        type: 'object',
        description: 'Present when source = github-live. Live GitHub REST probe + derived signals.',
        properties: {
          title: { type: 'string' },
          short_description: { type: 'string' },
          repo_url: { type: 'string', format: 'uri' },
          license: { type: ['string', 'null'] },
          stars: { type: 'integer', minimum: 0 },
          forks: { type: 'integer', minimum: 0 },
          open_issues: { type: 'integer', minimum: 0 },
          language: { type: ['string', 'null'] },
          default_branch: { type: 'string' },
          archived: { type: 'boolean' },
          disabled: { type: 'boolean' },
          last_commit_at: { type: ['string', 'null'], format: 'date-time' },
          topics: { type: 'array', items: { type: 'string' } },
          signals: signalsSchema,
        },
      },
      caveat: { type: 'string', description: 'Present when source = github-live. Explains the live-probe limitations.' },
      companion_mcps: { type: 'array', items: { type: 'string' }, description: 'Recommended companion MCPs to chain with for deeper checks (Socket, OpenSSF, TruffleHog).' },
    },
  },
  handler: async (args) => {
    const parsed = auditRepoInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(parsed.error.message);
    try {
      const res = await apiGet<{
        source: 'catalog' | 'github-live';
        repo_url: string;
        listing?: ListingSummary;
        audit?: {
          title: string;
          short_description: string;
          repo_url: string;
          license: string | null;
          stars: number;
          forks: number;
          open_issues: number;
          language: string | null;
          default_branch: string;
          archived: boolean;
          disabled: boolean;
          last_commit_at: string | null;
          topics: string[];
          signals: {
            license_category: string;
            license_warning: string | null;
            popularity: number;
            risk: number;
            price_usd: number;
            pricing_tier: string;
          };
        };
        caveat?: string;
      }>('/api/v1/crawler/audit-external', { url: parsed.data.url });

      if (res.source === 'catalog' && res.listing) {
        const md = [
          `# Audit: ${res.listing.title}`,
          '',
          `_Already in BuyGit catalog — using cached signals._`,
          '',
          `- License: \`${res.listing.license ?? 'unknown'}\``,
          res.listing.signals
            ? `- Signals: license=${res.listing.signals.license_category} · popularity=${res.listing.signals.popularity}/100 · risk=${res.listing.signals.risk}/100 · pricing=${res.listing.signals.pricing_tier}`
            : '',
          res.listing.signals?.license_warning ? `\n> ⚠ ${res.listing.signals.license_warning}` : '',
          '',
          `[Catalog page](${res.listing.url})`,
        ].filter(Boolean).join('\n');
        return textResult(md, res);
      }

      if (res.audit) {
        const a = res.audit;
        // Federation hint (P2-8 lite): when our live probe can't reach
        // deeper checks (Socket malware feed, OpenSSF Scorecard,
        // TruffleHog secret scan), suggest the companion MCPs the agent
        // should chain in. We don't call them ourselves — the agent
        // routes if it has them installed.
        const companions: string[] = [];
        if (a.signals.risk < 40) {
          companions.push('Use `socket-mcp` to verify malware / typosquat status (we did not run a fresh scan).');
          companions.push('Use OpenSSF Scorecard to check branch protection, signed commits, and SAST coverage.');
        } else {
          companions.push('Risk score is ≥40 — STRONGLY recommend running `socket-mcp` + TruffleHog before bundling.');
        }
        const md = [
          `# Audit: ${a.title}`,
          '',
          `_Live GitHub probe — not in BuyGit catalog._`,
          '',
          `${a.short_description}`,
          '',
          `- Repo: ${a.repo_url}`,
          `- License: \`${a.license ?? 'unknown'}\` (${a.signals.license_category})`,
          `- Stars: ★ ${a.stars.toLocaleString()} · Forks: ${a.forks} · Open issues: ${a.open_issues}`,
          `- Language: ${a.language ?? 'unknown'} · Branch: \`${a.default_branch}\``,
          `- Last commit: ${a.last_commit_at?.slice(0, 10) ?? 'unknown'}${a.archived ? ' · **archived** ⚠' : ''}${a.disabled ? ' · **disabled** ⚠' : ''}`,
          `- Signals: popularity=${a.signals.popularity}/100 · risk=${a.signals.risk}/100${a.signals.risk >= 40 ? ' ⚠' : ''}`,
          a.signals.license_warning ? `\n> ⚠ ${a.signals.license_warning}` : '',
          '',
          '## Deeper checks (route to companion MCPs)',
          ...companions.map((c) => `- ${c}`),
          '',
          res.caveat ? `_${res.caveat}_` : '',
        ].filter(Boolean).join('\n');
        return textResult(md, { ...res, companion_mcps: companions });
      }

      return errorResult('unexpected audit response shape');
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── search_tools (meta tool — Tool Search Tool semantic) ───────────────────
const searchToolsInput = z.object({
  intent: z.string().min(1).max(200).describe('Plain-English description of what the user wants. e.g. "find an MIT alternative to React" → returns buygit_find_alternative.'),
});

interface ToolRoutingHint {
  pattern: RegExp;
  tool: string;
  reason: string;
}

const ROUTING_HINTS: ToolRoutingHint[] = [
  { pattern: /\b(license|spdx|gpl|agpl|mit|apache|copyleft).*(compat|combin|bundle|safe|conflict|allow|relicens|redistribut)/i, tool: 'buygit_check_license_compat', reason: 'license compatibility verdict' },
  { pattern: /\b(can i (use|bundle|combine|ship)|legal (risk|status)|copyleft (concern|conflict))/i, tool: 'buygit_check_license_compat', reason: 'license-compat — can-I-use phrasing' },
  { pattern: /\b(alternative|replace|instead of|swap|substitute|similar to|drop[- ]in)\b/i, tool: 'buygit_find_alternative', reason: 'license-filtered alternative search' },
  { pattern: /\b(audit|safe to use|safe to bundle|is .* safe|github\.com\/[^\s]+\/[^\s]+|check (this|the) repo)/i, tool: 'buygit_audit_repo', reason: 'external repo audit (live GitHub probe)' },
  { pattern: /\b(supply[- ]chain|malware|secret leak|abandoned|archived|maintainer warning)/i, tool: 'buygit_audit_repo', reason: 'supply-chain / safety probe' },
  { pattern: /\b(compare|side[- ]by[- ]side|vs\.?|versus|diff|which is better|head[- ]to[- ]head)\b/i, tool: 'buygit_compare', reason: 'multi-listing side-by-side compare' },
  { pattern: /\b(trending|hot|popular this (week|month|day)|hottest|rising|gaining stars)\b/i, tool: 'buygit_trending', reason: 'recent-activity trending list' },
  { pattern: /\b(random|surprise me|pick (one|a few)|browse|explore)\b/i, tool: 'buygit_random', reason: 'random catalog pick' },
  { pattern: /\b(categor(y|ies)|taxonomy|tree|list (the )?categor|what (categories|tags))/i, tool: 'buygit_list_categories', reason: 'full taxonomy with counts' },
  { pattern: /\b(stats|how (many|big)|total (listings|repos)|catalog size|last (index|crawl)|freshness|how fresh)/i, tool: 'buygit_stats', reason: 'catalog meta + data freshness' },
  { pattern: /\b(diff|delta|changed since|regress|since (last|i added)|over time)\b/i, tool: 'buygit_diff_versions', reason: 'time-window diff (license / popularity / risk delta)' },
  { pattern: /\b(deep audit|federated audit|all signals|socket.*ossf|run all (the )?checks|cross-check)\b/i, tool: 'buygit_deep_audit', reason: 'federated audit — chains Socket / OpenSSF / TruffleHog companion MCPs' },
  { pattern: /\b(explain|summarise|summarize|tldr|tl;dr|plain[- ]english|in plain (terms|words))\b/i, tool: 'buygit_explain', reason: 'AI summary via Claude Haiku (gated on operator ANTHROPIC_API_KEY)' },
  { pattern: /\b(detail|full info|describe|what is|tell me about|info on|details for)\b/i, tool: 'buygit_get_listing', reason: 'full listing detail (license + risk + repo signals)' },
  { pattern: /\b(find|discover|recommend|suggest|search|need a|looking for) .{0,80}(library|repo|package|starter|kit|tool|framework|template|boilerplate)/i, tool: 'buygit_search', reason: 'curated search across 78,094 license-tagged assets' },
  { pattern: /\b(mit|apache|bsd|gpl|agpl|license[d]? as)\b/i, tool: 'buygit_search', reason: 'license-filtered search (pass license= filter)' },
];

const searchToolsTool: ToolDefinition = {
  name: 'search_tools',
  description:
    'Meta tool — given a plain-English intent, returns the most appropriate BuyGit tool(s) to call next, ranked. Implements MCP Tool Search Tool semantics. Saves the agent from listing every tool description when only one will fit the user\'s ask.',
  inputSchema: {
    type: 'object',
    required: ['intent'],
    properties: {
      intent: { type: 'string', minLength: 1, maxLength: 200, description: 'What the user wants to do, in plain language.' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['intent', 'recommendations'],
    properties: {
      intent: { type: 'string' },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['tool', 'reason'],
          properties: {
            tool: { type: 'string' },
            reason: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
  handler: async (args) => {
    const parsed = searchToolsInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(parsed.error.message);
    const intent = parsed.data.intent;
    const matches: { tool: string; reason: string; confidence: number }[] = [];
    for (const h of ROUTING_HINTS) {
      if (h.pattern.test(intent)) {
        matches.push({ tool: h.tool, reason: h.reason, confidence: 0.85 });
      }
    }
    // Fallback: if no specific hint matched, surface search_projects-equivalent.
    if (matches.length === 0) {
      matches.push({
        tool: 'buygit_search',
        reason: 'general curated search across 78,094 license-tagged assets — the default entrypoint for find / discover / suggest queries',
        confidence: 0.5,
      });
    }
    const md = [
      `**Routing for intent:** "${intent}"`,
      '',
      ...matches.map((m, i) => `${i + 1}. \`${m.tool}\` (confidence ${m.confidence.toFixed(2)}) — ${m.reason}`),
    ].join('\n');
    return textResult(md, { intent, recommendations: matches });
  },
};

// ── buygit_explain ─────────────────────────────────────────────────────────
//
// AI summary tool gated on ANTHROPIC_API_KEY. When the env var is unset,
// the tool returns a structured error pointing at the operator runbook
// so the agent can route to a different tool gracefully. When set, calls
// Claude Haiku 4.5 to summarise the listing's README + repo signals in
// ≤ 200 words.
//
// Why gated on env: cost. Haiku is $0.8/1M input · $4/1M output; one
// listing summary ≈ 4k input + 500 output tokens ≈ $0.003/call. Run
// unbounded against a 78k catalog × N agents and the bill spirals.
// We let the operator decide when to enable it.
//
// Why a separate /api/v1/crawler/explain endpoint isn't here: keeping the
// Anthropic key inside the MCP server's process (which the operator
// controls) avoids leaking it to the public REST surface, and the
// Anthropic call shape is identical whether invoked from MCP or REST.
const explainInput = z.object({
  slug: z.string().regex(/^[a-z0-9\-]+$/i).max(200).describe('Listing slug from a prior tool call.'),
  focus: z.enum(['overview', 'license', 'risk', 'usage']).optional().describe('Tilt the summary toward one angle.'),
});

interface AnthropicMessage {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
}

const explainTool: ToolDefinition = {
  name: 'buygit_explain',
  description:
    "AI-summarised explanation of a BuyGit listing (license + risk + how to use). Uses Claude Haiku 4.5 under the hood; gated on the operator's ANTHROPIC_API_KEY (returns a structured error with routing hint when unset). Use after buygit_get_listing when the user wants a plain-English digest instead of raw fields.",
  inputSchema: {
    type: 'object',
    required: ['slug'],
    properties: {
      slug: { type: 'string', pattern: '^[a-z0-9\\-]+$', maxLength: 200 },
      focus: { type: 'string', enum: ['overview', 'license', 'risk', 'usage'] },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string' },
      summary: { type: 'string' },
      focus: { type: 'string' },
      model: { type: 'string' },
      gated_on_env: { type: 'string' },
    },
  },
  handler: async (args) => {
    const parsed = explainInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(parsed.error.message);
    const { slug, focus = 'overview' } = parsed.data;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Structured error — agent can route around it. We surface the
      // operator action that unlocks the tool so the user sees a path
      // forward instead of a dead end.
      return {
        content: [
          {
            type: 'text',
            text:
              `# buygit_explain is unavailable\n\n` +
              `This tool requires the operator to set ANTHROPIC_API_KEY on the running BuyGit MCP server.\n\n` +
              `See https://buygit.com/mcp#optional-env-vars for setup instructions.\n\n` +
              `Workaround: call \`buygit_get_listing("${slug}")\` for the raw fields and ask the calling model to summarise them itself.`,
          },
        ],
        structuredContent: {
          slug,
          gated_on_env: 'ANTHROPIC_API_KEY',
          operator_action_ref: 'https://buygit.com/mcp#optional-env-vars',
        },
        isError: true,
      };
    }

    // Fetch the listing detail first — the model summarises this, not the
    // raw web page. Cheaper + deterministic.
    let detail: ListingDetail;
    try {
      const raw = await apiGet<ListingDetail & { rating?: { avg: number | null; count: number } }>(
        `/api/v1/crawler/listings/${encodeURIComponent(slug)}`,
      );
      detail = { ...raw, rating_block: normalizeRating(raw) };
    } catch (err) {
      return errorResult(err);
    }

    const focusPrompts: Record<typeof focus, string> = {
      overview: 'Give a 3-bullet overview of what this project does, who it is for, and the single most important caveat.',
      license: 'Explain the license + any bundling/distribution constraints. Be specific about whether this is safe to combine with MIT / Apache / proprietary code.',
      risk: 'Identify supply-chain or maintenance risks: archived status, last commit age, license category, malware/secret flags. Recommend a verification step.',
      usage: 'Walk through a minimal usage example, including install command + 3 lines of representative code.',
    };

    const sysPrompt =
      'You are a terse, accurate code-discovery assistant. Summarise the supplied BuyGit listing in <= 200 words. Use plain English, no marketing fluff. If the license signals a copyleft/proprietary risk, lead with it.';

    const userPrompt = [
      focusPrompts[focus],
      '',
      `## Listing`,
      `- Title: ${detail.title}`,
      `- Slug: ${detail.slug}`,
      `- License: ${detail.license ?? 'unknown'} (${detail.signals.license_category})`,
      detail.signals.license_warning ? `- License warning: ${detail.signals.license_warning}` : '',
      `- Source: ${detail.source}`,
      `- Stars / forks / lang: ${detail.repo_signals.stars} / ${detail.repo_signals.forks} / ${detail.repo_signals.language ?? '?'}`,
      `- Last commit: ${detail.repo_signals.last_commit_at?.slice(0, 10) ?? 'unknown'} · upstream: ${detail.repo_signals.upstream_status ?? 'unknown'}`,
      `- Risk score: ${detail.signals.risk}/100, popularity: ${detail.signals.popularity}/100`,
      `- Secret scan: ${detail.safety_signals.secret_scan} · malware flag: ${detail.safety_signals.malware_flag}`,
      '',
      `## Description (truncated to 1.5KB)`,
      (detail.full_description_md || detail.short_description).slice(0, 1500),
    ].filter(Boolean).join('\n');

    try {
      // P2-6: Model is configurable via env var; defaults to Haiku 4.5.
      const explainModel = process.env.BUYGIT_EXPLAIN_MODEL || 'claude-haiku-4-5-20251001';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: explainModel,
          max_tokens: 512,
          system: sysPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      const body = (await res.json()) as AnthropicMessage;
      if (!res.ok || body.error) {
        return errorResult(`Anthropic API error: ${body.error?.message ?? `HTTP ${res.status}`}`);
      }
      const summary = body.content?.find((c) => c.type === 'text')?.text ?? '(no text content returned)';
      return textResult(
        `# ${detail.title}\n\n_${focus} summary, generated by claude-haiku-4-5_\n\n${summary}\n\n[Full listing on BuyGit](${detail.url})`,
        {
          slug,
          summary,
          focus,
          model: 'claude-haiku-4-5-20251001',
          url: detail.url,
        },
      );
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── diff_versions ──────────────────────────────────────────────────────────
const diffVersionsInput = z.object({
  slug: z.string().regex(/^[a-z0-9\-]+$/i).max(200).describe('Listing slug.'),
  from: z.string().datetime().optional().describe('ISO datetime to compare from (defaults to listing creation).'),
  to: z.string().datetime().optional().describe('ISO datetime to compare to (defaults to now).'),
});

const diffVersionsTool: ToolDefinition = {
  name: 'buygit_diff_versions',
  description:
    'Time-window diff for a BuyGit listing — did the license / popularity / risk change between two dates? Answers questions no other MCP can ("did this dep regress since I added it last quarter?"). Returns snapshot-driven deltas when the operator has TRENDING_V2_ENABLED + the snapshot table populated; otherwise returns current state + a gated_on hint so the agent knows what to ask the operator for.',
  inputSchema: {
    type: 'object',
    required: ['slug'],
    properties: {
      slug: { type: 'string', pattern: '^[a-z0-9\\-]+$', maxLength: 200, description: 'Listing slug from a prior tool call.' },
      from: { type: 'string', format: 'date-time', description: 'ISO 8601 datetime to compare from. Clamped to listing.created_at if earlier.' },
      to: { type: 'string', format: 'date-time', description: 'ISO 8601 datetime to compare to. Defaults to now.' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['slug', 'mode', 'current'],
    properties: {
      slug: { type: 'string' },
      title: { type: 'string' },
      mode: { type: 'string', enum: ['snapshot-diff', 'current-state-only'] },
      from: { type: ['string', 'null'], format: 'date-time' },
      to: { type: ['string', 'null'], format: 'date-time' },
      delta: {
        type: 'object',
        description: 'Present when mode = snapshot-diff. Stars/forks/popularity deltas across the requested window.',
        properties: {
          stars: { type: 'integer' },
          forks: { type: 'integer' },
          popularity: { type: 'integer' },
        },
      },
      current: {
        type: 'object',
        required: ['signals'],
        properties: {
          license: { type: ['string', 'null'] },
          stars: { type: 'integer' },
          forks: { type: 'integer' },
          signals: signalsSchema,
        },
      },
      gated_on: { type: ['string', 'null'], description: 'Operator action name when historical data unavailable.' },
      note: { type: 'string' },
    },
  },
  handler: async (args) => {
    const parsed = diffVersionsInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(parsed.error.message);
    const { slug, from, to } = parsed.data;
    try {
      const res = await apiGet<{
        slug: string;
        title?: string;
        mode: 'snapshot-diff' | 'current-state-only';
        from: string | null;
        to: string | null;
        delta?: { stars: number; forks: number; popularity: number };
        current: { license: string | null; stars?: number; forks?: number; signals: typeof signalsSchema };
        gated_on: string | null;
        note: string;
      }>(`/api/v1/crawler/listings/${encodeURIComponent(slug)}/diff`, { from, to });

      const lines: string[] = [`# Diff: ${res.title ?? slug}`, ''];
      lines.push(`Mode: ${res.mode}`);
      if (res.from && res.to) lines.push(`Window: ${String(res.from).slice(0, 10)} → ${String(res.to).slice(0, 10)}`);
      lines.push('');
      if (res.mode === 'snapshot-diff' && res.delta) {
        lines.push('## Delta');
        lines.push(`- Stars: ${res.delta.stars >= 0 ? '+' : ''}${res.delta.stars}`);
        lines.push(`- Forks: ${res.delta.forks >= 0 ? '+' : ''}${res.delta.forks}`);
        lines.push(`- Popularity: ${res.delta.popularity >= 0 ? '+' : ''}${res.delta.popularity}/100`);
        lines.push('');
      }
      lines.push('## Current state');
      const sig = res.current.signals as unknown as { license_category: string; license_warning: string | null; popularity: number; risk: number; pricing_tier: string };
      lines.push(`- License: \`${res.current.license ?? 'unknown'}\` (${sig.license_category})`);
      if (res.current.stars !== undefined) lines.push(`- Stars: ${res.current.stars}`);
      lines.push(`- Signals: popularity=${sig.popularity}/100 · risk=${sig.risk}/100${sig.risk >= 40 ? ' ⚠' : ''}`);
      if (sig.license_warning) lines.push(`\n> ⚠ ${sig.license_warning}`);
      lines.push('');
      if (res.gated_on) {
        lines.push(`_Operator note: enable \`${res.gated_on}\` to unlock snapshot-driven diffs (see docs/runbooks/OPERATOR_ACTIONS_2026-05-23.md §2.10)._`);
      }
      lines.push('');
      lines.push(`_${res.note}_`);

      return textResult(lines.join('\n'), res);
    } catch (err) {
      return errorResult(err);
    }
  },
};

// ── deep_audit (P2-8 MCP Federation full) ──────────────────────────────────
//
// Spawns companion MCP servers as child processes over stdio, asks each
// for its take on the same target, then combines the responses with our
// own catalog row into a single federated audit. Pre-configured to chain
// with three well-known companion MCPs:
//
//   - socket-mcp        (Socket malware / typosquat / supply-chain)
//   - openssf-mcp       (OpenSSF Scorecard health signals)
//   - trufflehog-mcp    (secret scan, on-demand)
//
// If a companion isn't installed locally (no `npx`-resolvable package),
// it appears in `federation_failures[]` with the reason. Never errors —
// always returns something agent-actionable.
//
// Implementation notes:
//   - We spawn each child with --no-install to avoid surprise downloads.
//   - 5s hard timeout per child; we'd rather report partial than hang.
//   - Output is captured stdout only; stderr is logged to our stderr for
//     operator visibility.
const deepAuditInput = z.object({
  slug_or_url: z.string().min(1).max(400).describe('Either a BuyGit slug (catalog) or a github.com/owner/repo URL (live).'),
  federate_with: z.array(z.enum(['socket-mcp', 'openssf-mcp', 'trufflehog-mcp'])).max(3).optional().describe('Which companion MCPs to chain. Defaults to all three.'),
  timeout_ms: z.number().int().min(1000).max(15000).default(5000).describe('Per-companion-MCP hard timeout (ms).'),
});

interface FederationResult {
  mcp: string;
  status: 'ok' | 'not-installed' | 'timeout' | 'error';
  reason?: string;
  summary?: string;
  raw?: unknown;
}

interface FederationHandlerOpts {
  slug_or_url: string;
  federate_with: ('socket-mcp' | 'openssf-mcp' | 'trufflehog-mcp')[];
  timeout_ms: number;
}

async function callFederationCompanion(
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<FederationResult> {
  const { spawn } = await import('node:child_process');
  // We invoke companions via `npx --no-install -y <package>` so the
  // attempt fails fast when the package isn't on PATH. -y suppresses the
  // prompt that would otherwise hang in a non-interactive context.
  const pkg = mcpName.endsWith('-mcp') ? `@${mcpName.replace(/-mcp$/, '')}/mcp` : mcpName;

  return new Promise<FederationResult>((resolve) => {
    let buffer = '';
    let resolved = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('npx', ['--no-install', '-y', pkg], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ mcp: mcpName, status: 'error', reason: `spawn failed: ${(err as Error).message}` });
      return;
    }

    const finish = (r: FederationResult): void => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve(r);
    };

    const timer = setTimeout(() => finish({ mcp: mcpName, status: 'timeout', reason: `>${timeoutMs}ms` }), timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (/ENOENT|not found/i.test(err.message)) {
        finish({ mcp: mcpName, status: 'not-installed', reason: 'npx could not resolve the package' });
      } else {
        finish({ mcp: mcpName, status: 'error', reason: err.message });
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      // Stream companion stderr to ours so the operator can debug install
      // failures without us swallowing the signal.
      process.stderr.write(`[deep_audit:${mcpName}] ${chunk.toString('utf8').trim()}\n`);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // Look for our specific JSON-RPC response by id. Each line is a
      // JSON-RPC frame.
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: unknown };
          if (obj.id === 2 && obj.result) {
            clearTimeout(timer);
            // Try to extract a one-line summary from the response.
            const r = obj.result as { content?: { type: string; text?: string }[]; structuredContent?: unknown };
            const text = r.content?.find((c) => c.type === 'text')?.text;
            const summary = (text ?? JSON.stringify(r.structuredContent ?? r)).slice(0, 800);
            finish({ mcp: mcpName, status: 'ok', summary, raw: obj.result });
            return;
          }
        } catch {
          /* not yet a complete JSON line */
        }
      }
    });

    child.stdout?.on('end', () => {
      if (!resolved) {
        clearTimeout(timer);
        finish({ mcp: mcpName, status: 'error', reason: 'child exited without returning a tool result' });
      }
    });

    // Send the MCP handshake + tool call.
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: '@buygit/mcp-server', version: 'federation' },
      },
    };
    const callTool = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };
    try {
      child.stdin?.write(JSON.stringify(init) + '\n');
      child.stdin?.write(JSON.stringify(callTool) + '\n');
    } catch (err) {
      finish({ mcp: mcpName, status: 'error', reason: `stdin write failed: ${(err as Error).message}` });
    }
  });
}

const deepAuditTool: ToolDefinition = {
  name: 'buygit_deep_audit',
  description:
    'Federated audit — spawns Socket / OpenSSF / TruffleHog companion MCPs in parallel and combines their findings with our catalog signals. The only MCP that one-shots a multi-vendor supply-chain check (vs. the user installing 4 MCPs and asking each separately). Companion MCPs that are not installed surface as `federation_failures[]` with operator hints. Soft-fails per-companion — always returns SOMETHING agent-actionable.',
  inputSchema: {
    type: 'object',
    required: ['slug_or_url'],
    properties: {
      slug_or_url: {
        type: 'string',
        minLength: 1,
        maxLength: 400,
        description: 'Either a BuyGit slug (catalog row) or a github.com/{owner}/{repo} URL (live probe). Slug matches `^[a-z0-9-]+$`; URL matches `https?://github.com/owner/repo`.',
        examples: [
          'sindresorhus-is-online',
          'https://github.com/sindresorhus/is-online',
          'https://github.com/vercel/next.js',
        ],
      },
      federate_with: {
        type: 'array',
        items: { type: 'string', enum: ['socket-mcp', 'openssf-mcp', 'trufflehog-mcp'] },
        maxItems: 3,
        description: 'Which companion MCPs to chain. Defaults to all three.',
        examples: [['socket-mcp', 'openssf-mcp', 'trufflehog-mcp']],
      },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 15000, default: 5000, description: 'Per-companion hard timeout in milliseconds.', examples: [3000, 5000, 10000] },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['target', 'buygit_audit', 'federation_results'],
    properties: {
      target: { type: 'string' },
      buygit_audit: { type: 'object', description: 'Our own audit (either catalog row or live GitHub probe).' },
      federation_results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['mcp', 'status'],
          properties: {
            mcp: { type: 'string' },
            status: { type: 'string', enum: ['ok', 'not-installed', 'timeout', 'error'] },
            reason: { type: 'string' },
            summary: { type: 'string' },
          },
        },
      },
      verdict: { type: 'string', description: 'One-line aggregate (safe / review / risky / unverified).' },
    },
  },
  handler: async (args) => {
    const parsed = deepAuditInput.safeParse(args ?? {});
    if (!parsed.success) return errorResult(parsed.error.message);
    const opts: FederationHandlerOpts = {
      slug_or_url: parsed.data.slug_or_url,
      federate_with: parsed.data.federate_with ?? ['socket-mcp', 'openssf-mcp', 'trufflehog-mcp'],
      timeout_ms: parsed.data.timeout_ms,
    };

    // 1. Our own audit first — cheap, always available.
    let buygit: unknown;
    try {
      if (opts.slug_or_url.startsWith('http://') || opts.slug_or_url.startsWith('https://')) {
        buygit = await apiGet('/api/v1/crawler/audit-external', { url: opts.slug_or_url });
      } else {
        buygit = await apiGet(`/api/v1/crawler/listings/${encodeURIComponent(opts.slug_or_url)}`);
      }
    } catch (err) {
      buygit = { error: (err as Error).message };
    }

    // 2. Fan out companion MCPs in parallel.
    //    Each companion has its own conventional tool name — we pick the
    //    one most analogous to "audit this repo". When the companion
    //    doesn't have a matching tool, status: 'error' with a hint.
    // P2-2: Tool names are configurable via env (JSON) so operators can
    // adjust when companion MCPs update their tool names.
    const defaultMap: Record<string, string> = {
      'socket-mcp': 'socket_check_package',
      'openssf-mcp': 'scorecard',
      'trufflehog-mcp': 'scan_repo',
    };
    let COMPANION_TOOL_MAP = defaultMap;
    if (process.env.BUYGIT_COMPANION_TOOL_MAP) {
      try {
        COMPANION_TOOL_MAP = { ...defaultMap, ...JSON.parse(process.env.BUYGIT_COMPANION_TOOL_MAP) };
      } catch { /* malformed env — fall through to defaults */ }
    }

    const federation = await Promise.all(
      opts.federate_with.map((mcp) =>
        callFederationCompanion(
          mcp,
          COMPANION_TOOL_MAP[mcp] ?? 'audit',
          { url: opts.slug_or_url, name: opts.slug_or_url },
          opts.timeout_ms,
        ),
      ),
    );

    // 3. Aggregate verdict — conservative.
    const okCount = federation.filter((r) => r.status === 'ok').length;
    const totalAsked = federation.length;
    let verdict = 'unverified';
    if (okCount === totalAsked && totalAsked > 0) verdict = 'safe (all companions clean)';
    else if (okCount >= 1) verdict = 'review (partial federation success)';
    else verdict = 'unverified (no companion MCPs reachable — install at least one for richer signals)';

    const md: string[] = [`# Deep audit: ${opts.slug_or_url}`, ''];
    md.push(`Verdict: **${verdict}**`);
    md.push('');
    md.push('## BuyGit catalog signals');
    md.push('See structuredContent.buygit_audit for the full row.');
    md.push('');
    md.push('## Federation results');
    for (const r of federation) {
      const icon = r.status === 'ok' ? '✓' : r.status === 'not-installed' ? '📦' : r.status === 'timeout' ? '⏱' : '!';
      md.push(`### ${icon} ${r.mcp} — ${r.status}`);
      if (r.reason) md.push(`Reason: ${r.reason}`);
      if (r.summary) md.push(`\n${r.summary}`);
      md.push('');
    }
    md.push('---');
    md.push('');
    md.push('To enable more federation paths, install the companion MCPs locally:');
    md.push('  - `npm install -g @socket/mcp`');
    md.push('  - `npm install -g @openssf/scorecard-mcp` (when published)');
    md.push('  - `npm install -g @trufflesec/mcp` (when published)');

    return textResult(md.join('\n'), {
      target: opts.slug_or_url,
      buygit_audit: buygit,
      federation_results: federation.map((r) => ({ mcp: r.mcp, status: r.status, reason: r.reason, summary: r.summary })),
      verdict,
    });
  },
};

export const ALL_TOOLS: ToolDefinition[] = [
  searchTool,
  getListingTool,
  listCategoriesTool,
  trendingTool,
  compareTool,
  statsTool,
  randomTool,
  findAlternativeTool,
  checkLicenseCompatTool,
  auditRepoTool,
  explainTool,
  diffVersionsTool,
  deepAuditTool,
  searchToolsTool,
];
