/**
 * MCP resources — let the user "@-mention" a BuyGit listing, category, or a
 * side-by-side comparison in Claude Desktop / Cursor and have the full
 * content attached as context, without burning a tool call.
 *
 * URI templates
 *   buygit://listing/{slug}                    — full Markdown for one listing
 *   buygit://category/{slug}                   — top 20 in a category
 *   buygit://compare/{slug-a}+{slug-b}         — single-call 2-way compare
 *
 * The SDK queries `resources/templates/list` and `resources/list` separately;
 * we only expose templates (clients then construct URIs at use time).
 */
import { apiGet } from './client.js';
import { detailBlock, summaryList, compareBlock, type ListingSummary, type ListingDetail } from './format/markdown.js';

/** Centralised rating normaliser — mirrors the one in tools.ts. */
function normalizeRating(raw: { rating?: { avg: number | null; count: number } }): { avg: number | null; count: number } {
  return raw.rating ?? { avg: null, count: 0 };
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: 'buygit://listing/{slug}',
    name: 'BuyGit listing',
    description:
      'Full Markdown detail for a single crawler-imported listing, including 4-axis signals (license_category + license_warning + popularity + risk + pricing). Replace {slug} with the slug from a previous search/trending result.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'buygit://category/{slug}',
    name: 'BuyGit category top listings',
    description:
      'Markdown summary of a category — the top 20 crawler listings by stars within it, each with license + risk + popularity badges. Replace {slug} with a category slug from buygit_list_categories.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'buygit://compare/{slugs}',
    name: 'BuyGit side-by-side comparison',
    description:
      'Compare 2-5 listings in a single resource fetch. Replace {slugs} with a "+"-joined list of 2-5 slugs (e.g. `react+vue+svelte`). Returns license_category, license_warning, popularity, risk, and pricing for every slug — the answer github-mcp / Smithery cannot give in one call.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'buygit://trending/{period}',
    name: 'BuyGit trending (cacheable)',
    description:
      'Top 20 trending crawler listings for a period: `day` | `week` | `month`. Each carries license + risk + popularity. Pin once, re-reference — saves a tools/call per turn.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'buygit://stats',
    name: 'BuyGit catalog stats (cacheable)',
    description:
      'Catalog meta — total listings, by-license / by-category / by-source breakdowns, last_indexed_at + data_freshness (hours since last index, recent-commit counts, archived count). Pin to know catalog scale + freshness without burning a tools/call.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'buygit://category-tree',
    name: 'BuyGit category tree (cacheable)',
    description:
      'Full BuyGit category taxonomy with per-category crawler listing counts. Pin once to use as a category-slug lookup table.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'buygit://license/{spdx}',
    name: 'BuyGit license matrix row',
    description:
      'Compatibility matrix row for a given SPDX license id. Returns how the license interacts with permissive / weak-copyleft / strong-copyleft / public-domain / proprietary / unknown targets. Source-of-truth for `buygit_check_license_compat` answers.',
    mimeType: 'text/markdown',
  },
];

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

const URI_RE = /^buygit:\/\/(listing|category|compare|trending|stats|category-tree|license)(?:\/(.+))?$/i;
const SLUG_RE = /^[a-z0-9\-]+$/i;
const SPDX_RE = /^[A-Za-z0-9.\-+]+$/;

export async function readResource(uri: string): Promise<ResourceContent> {
  const match = URI_RE.exec(uri);
  if (!match) throw new Error(`unsupported resource uri: ${uri}`);
  const [, kind, tail] = match;

  if (kind === 'stats') {
    const s = await apiGet<{
      total_listings: number;
      last_indexed_at: string | null;
      by_license: { license: string; count: number }[];
      by_category: { slug: string; name: string; count: number }[];
      by_source: { source: string; count: number }[];
      data_freshness?: {
        hours_since_last_index: number | null;
        listings_with_recent_commit_30d: number;
        listings_with_recent_commit_180d: number;
        listings_archived: number;
      };
    }>('/api/v1/crawler/stats');
    const lines: string[] = [];
    lines.push(`# BuyGit catalog stats`);
    lines.push('');
    lines.push(`- Total listings: **${s.total_listings.toLocaleString()}**`);
    if (s.last_indexed_at) lines.push(`- Last indexed: ${s.last_indexed_at}`);
    if (s.data_freshness) {
      lines.push(`- Hours since last index: ${s.data_freshness.hours_since_last_index ?? 'n/a'}`);
      lines.push(`- Recent commits (30d): ${s.data_freshness.listings_with_recent_commit_30d.toLocaleString()}`);
      lines.push(`- Recent commits (180d): ${s.data_freshness.listings_with_recent_commit_180d.toLocaleString()}`);
      lines.push(`- Archived listings: ${s.data_freshness.listings_archived.toLocaleString()}`);
    }
    lines.push('');
    lines.push('## Top licenses');
    for (const l of s.by_license.slice(0, 10)) lines.push(`- ${l.license}: ${l.count.toLocaleString()}`);
    lines.push('');
    lines.push('## Top categories');
    for (const c of s.by_category.slice(0, 10)) lines.push(`- ${c.name} \`${c.slug}\`: ${c.count.toLocaleString()}`);
    return { uri, mimeType: 'text/markdown', text: lines.join('\n') };
  }

  if (kind === 'category-tree') {
    interface Node { slug: string; name: string; crawler_listing_count: number; children: Node[] }
    const res = await apiGet<{ categories: Node[] }>('/api/v1/crawler/categories');
    const lines: string[] = ['# BuyGit category tree (crawler listings only)', ''];
    function walk(node: Node, depth: number): void {
      const indent = '  '.repeat(depth);
      lines.push(`${indent}- **${node.name}** \`${node.slug}\` · ${node.crawler_listing_count}`);
      for (const c of node.children) walk(c, depth + 1);
    }
    for (const root of res.categories) walk(root, 0);
    return { uri, mimeType: 'text/markdown', text: lines.join('\n') };
  }

  if (kind === 'trending') {
    if (!tail || !/^(day|week|month)$/.test(tail)) {
      throw new Error(`trending uri must be day|week|month, got ${tail}`);
    }
    const res = await apiGet<{ period: string; results: ListingSummary[]; count: number }>(
      '/api/v1/crawler/trending',
      { period: tail, limit: 20 },
    );
    return {
      uri,
      mimeType: 'text/markdown',
      text: summaryList(res.results, {
        header: `# Trending (${tail}) — top ${res.count}`,
        footer: '_Pinned resource — agent may re-reference without a tools/call._',
      }),
    };
  }

  if (kind === 'license') {
    if (!tail || !SPDX_RE.test(tail)) throw new Error(`invalid SPDX id in uri: ${tail}`);
    const res = await apiGet<{
      source?: { spdx: string; category: string };
      verdict?: string;
      note?: string;
    } | {
      categories: string[];
      matrix: Record<string, Record<string, { verdict: string; note: string }>>;
      disclaimer: string;
    }>('/api/v1/crawler/license-compat', {});
    if (!('matrix' in res)) throw new Error('unexpected license-compat shape');

    // P2-4: Derive source category from the full matrix + a single
    // paired call instead of two calls. We issue one paired call
    // against MIT (always present) to determine the source category.
    const pair = await apiGet<{ source: { spdx: string; category: string } }>(
      '/api/v1/crawler/license-compat',
      { source: tail, target: 'MIT' },
    );
    const cat = pair.source.category as keyof typeof res.matrix;
    const row = res.matrix[cat];
    if (!row) throw new Error(`no matrix row for category ${cat}`);
    const lines: string[] = [`# License compatibility: ${tail} (\`${cat}\`)`, ''];
    for (const [target, cell] of Object.entries(row)) {
      const emoji = cell.verdict === 'compatible' ? '✅' : cell.verdict === 'incompatible' ? '❌' : '⚠️';
      lines.push(`${emoji} **${target}** — ${cell.verdict}`);
      lines.push(`> ${cell.note}`);
      lines.push('');
    }
    lines.push(`_${res.disclaimer}_`);
    return { uri, mimeType: 'text/markdown', text: lines.join('\n') };
  }

  if (kind === 'listing') {
    if (!SLUG_RE.test(tail!)) throw new Error(`invalid slug in uri: ${uri}`);
    const raw = await apiGet<ListingDetail & { rating?: { avg: number | null; count: number } }>(
      `/api/v1/crawler/listings/${encodeURIComponent(tail!)}`,
    );
    const detail: ListingDetail = { ...raw, rating_block: normalizeRating(raw) };
    return { uri, mimeType: 'text/markdown', text: detailBlock(detail) };
  }

  if (kind === 'category') {
    if (!SLUG_RE.test(tail!)) throw new Error(`invalid category slug in uri: ${uri}`);
    const list = await apiGet<{ results: ListingSummary[]; has_more: boolean }>(
      '/api/v1/crawler/search',
      { category: tail, sort: 'stars', limit: 20 },
    );
    return {
      uri,
      mimeType: 'text/markdown',
      text: summaryList(list.results, {
        header: `**Category: \`${tail}\` — top 20 by stars**`,
        footer: list.has_more ? '_More listings exist — use buygit_search with this category to paginate._' : undefined,
      }),
    };
  }

  // compare — slugs joined by '+'
  const slugs = tail!.split('+').map((s) => s.trim()).filter(Boolean);
  if (slugs.length < 2 || slugs.length > 5) {
    throw new Error(`compare uri must contain 2-5 slugs joined by '+', got ${slugs.length}`);
  }
  for (const s of slugs) {
    if (!SLUG_RE.test(s)) throw new Error(`invalid slug in compare uri: ${s}`);
  }
  const res = await apiGet<{ items: (ListingDetail | { slug: string; error: string })[] }>(
    '/api/v1/crawler/compare',
    { slugs: slugs.join(',') },
  );
  const items = res.items.map((it) => {
    if ('error' in it) return it;
    const r = it as ListingDetail & { rating?: { avg: number | null; count: number } };
    return { ...r, rating_block: normalizeRating(r) } as ListingDetail;
  });
  return { uri, mimeType: 'text/markdown', text: compareBlock(items) };
}
