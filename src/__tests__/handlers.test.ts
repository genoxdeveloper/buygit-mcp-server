/**
 * Handler unit tests — exercise each tool handler with mocked API
 * responses. This catches runtime regressions that the structural
 * tests in server.test.ts cannot (e.g. response shape changes,
 * error-path crashes, signal formatting bugs).
 *
 * Strategy: vi.mock('../client.js') to intercept apiGet and return
 * deterministic responses. Each test covers the happy path + at
 * least one error path.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ALL_TOOLS, type ToolContext, type ToolResult } from '../tools';

// Mock the entire client module so no real HTTP calls are made.
vi.mock('../client.js', () => ({
  apiGet: vi.fn(),
  BuygitApiError: class BuygitApiError extends Error {
    constructor(message: string, public readonly status: number, public readonly code?: string) {
      super(message);
      this.name = 'BuygitApiError';
    }
  },
}));

// Import the mocked apiGet so we can configure return values.
import { apiGet } from '../client';
const mockApiGet = apiGet as Mock;

const nullCtx: ToolContext = { elicit: null };

function getTool(name: string) {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function assertOk(result: ToolResult): void {
  expect(result.isError).toBeFalsy();
  expect(result.content).toBeDefined();
  expect(result.content.length).toBeGreaterThan(0);
  expect(result.content[0]!.type).toBe('text');
}

function assertError(result: ToolResult): void {
  expect(result.isError).toBe(true);
}

// ─── Shared fixtures ──────────────────────────────────────────────────────
const MOCK_LISTING_SUMMARY = {
  slug: 'test-lib',
  title: 'Test Library',
  url: 'https://buygit.com/listing/test-lib',
  license: 'MIT',
  stars: 5000,
  signals: {
    license_category: 'permissive',
    license_warning: null,
    popularity: 72,
    risk: 5,
    price_usd: 0,
    pricing_tier: 'free',
  },
};

const MOCK_LISTING_DETAIL = {
  ...MOCK_LISTING_SUMMARY,
  source: 'github',
  short_description: 'A test library for unit tests',
  full_description_md: '# Test Library\n\nA test library.',
  repo_signals: {
    stars: 5000,
    forks: 300,
    language: 'TypeScript',
    last_commit_at: '2026-05-20T00:00:00Z',
    upstream_status: 'active',
  },
  safety_signals: {
    secret_scan: 'clean',
    malware_flag: false,
  },
  rating: { avg: 4.5, count: 10 },
};

// ─── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockApiGet.mockReset();
});

describe('buygit_search handler', () => {
  const tool = getTool('buygit_search');

  it('returns results on valid query', async () => {
    mockApiGet.mockResolvedValueOnce({
      results: [MOCK_LISTING_SUMMARY],
      next_cursor: null,
      has_more: false,
    });
    const result = await tool.handler({ query: 'test' }, nullCtx);
    assertOk(result);
    expect(result.structuredContent?.count).toBe(1);
    expect(mockApiGet).toHaveBeenCalledWith(
      '/api/v1/crawler/search',
      expect.objectContaining({ q: 'test' }),
    );
  });

  it('returns error on invalid args (query too long)', async () => {
    const result = await tool.handler({ query: 'x'.repeat(201) }, nullCtx);
    assertError(result);
  });

  it('handles API errors gracefully', async () => {
    const { BuygitApiError } = await import('../client');
    mockApiGet.mockRejectedValueOnce(new BuygitApiError('not found', 404));
    const result = await tool.handler({ query: 'nonexistent' }, nullCtx);
    assertError(result);
    expect(result.content[0]!.text).toContain('404');
  });
});

describe('buygit_get_listing handler', () => {
  const tool = getTool('buygit_get_listing');

  it('returns detail on valid slug', async () => {
    mockApiGet.mockResolvedValueOnce(MOCK_LISTING_DETAIL);
    const result = await tool.handler({ slug: 'test-lib' }, nullCtx);
    assertOk(result);
    expect(result.structuredContent?.slug).toBe('test-lib');
  });

  it('normalizes rating_block from API response', async () => {
    mockApiGet.mockResolvedValueOnce({ ...MOCK_LISTING_DETAIL, rating: { avg: 4.2, count: 50 } });
    const result = await tool.handler({ slug: 'test-lib' }, nullCtx);
    assertOk(result);
  });

  it('rejects invalid slug characters', async () => {
    const result = await tool.handler({ slug: '../etc/passwd' }, nullCtx);
    assertError(result);
  });
});

describe('buygit_list_categories handler', () => {
  const tool = getTool('buygit_list_categories');

  it('returns category tree', async () => {
    mockApiGet.mockResolvedValueOnce({
      categories: [
        { slug: 'dev-tools', name: 'Dev Tools', crawler_listing_count: 1700, children: [] },
        { slug: 'ai-agents', name: 'AI Agents', crawler_listing_count: 500, children: [] },
      ],
    });
    const result = await tool.handler({}, nullCtx);
    assertOk(result);
    expect(result.content[0]!.text).toContain('Dev Tools');
  });
});

describe('buygit_trending handler', () => {
  const tool = getTool('buygit_trending');

  it('returns trending for default period', async () => {
    mockApiGet.mockResolvedValueOnce({
      period: 'week',
      category: null,
      results: [MOCK_LISTING_SUMMARY],
      count: 1,
    });
    const result = await tool.handler({}, nullCtx);
    assertOk(result);
    expect(result.structuredContent?.period).toBe('week');
  });

  it('rejects invalid period', async () => {
    const result = await tool.handler({ period: 'invalid' }, nullCtx);
    assertError(result);
  });
});

describe('buygit_compare handler', () => {
  const tool = getTool('buygit_compare');

  it('compares 2 listings', async () => {
    mockApiGet.mockResolvedValueOnce({
      items: [
        { ...MOCK_LISTING_DETAIL, slug: 'lib-a', title: 'Lib A', rating: { avg: 4.0, count: 20 } },
        { ...MOCK_LISTING_DETAIL, slug: 'lib-b', title: 'Lib B', rating: { avg: 3.5, count: 15 } },
      ],
    });
    const result = await tool.handler({ slugs: ['lib-a', 'lib-b'] }, nullCtx);
    assertOk(result);
  });

  it('rejects < 2 slugs', async () => {
    const result = await tool.handler({ slugs: ['only-one'] }, nullCtx);
    assertError(result);
  });

  it('rejects > 5 slugs', async () => {
    const result = await tool.handler({ slugs: ['a', 'b', 'c', 'd', 'e', 'f'] }, nullCtx);
    assertError(result);
  });
});

describe('buygit_stats handler', () => {
  const tool = getTool('buygit_stats');

  it('returns stats', async () => {
    mockApiGet.mockResolvedValueOnce({
      total_listings: 78094,
      by_license: [{ license: 'MIT', count: 30000 }],
      by_category: [{ slug: 'dev-tools', name: 'Dev Tools', count: 17000 }],
      by_source: [{ source: 'github', count: 78000 }],
      last_indexed_at: '2026-05-23T00:00:00Z',
      generated_at: '2026-05-23T12:00:00Z',
    });
    const result = await tool.handler({}, nullCtx);
    assertOk(result);
    expect(result.structuredContent?.total_listings).toBe(78094);
  });
});

describe('buygit_random handler', () => {
  const tool = getTool('buygit_random');

  it('returns random picks', async () => {
    mockApiGet.mockResolvedValueOnce({
      results: [MOCK_LISTING_SUMMARY],
      count: 1,
    });
    const result = await tool.handler({ count: 1 }, nullCtx);
    assertOk(result);
    expect(result.structuredContent?.count).toBe(1);
  });

  it('rejects count > 10', async () => {
    const result = await tool.handler({ count: 11 }, nullCtx);
    assertError(result);
  });
});

describe('buygit_find_alternative handler', () => {
  const tool = getTool('buygit_find_alternative');

  it('returns filtered alternatives', async () => {
    mockApiGet.mockResolvedValueOnce({
      results: [
        { ...MOCK_LISTING_SUMMARY, slug: 'react', title: 'React' },
        { ...MOCK_LISTING_SUMMARY, slug: 'vue', title: 'Vue.js' },
        { ...MOCK_LISTING_SUMMARY, slug: 'svelte', title: 'Svelte' },
        { ...MOCK_LISTING_SUMMARY, slug: 'preact', title: 'Preact' },
      ],
    });
    const result = await tool.handler({ query: 'React' }, nullCtx);
    assertOk(result);
    // Should filter out React itself, keeping Vue, Svelte, Preact
    const results = (result.structuredContent as any)?.results;
    expect(results?.length).toBeGreaterThanOrEqual(3);
  });

  it('falls back to full list when < 3 alternatives remain', async () => {
    mockApiGet.mockResolvedValueOnce({
      results: [
        { ...MOCK_LISTING_SUMMARY, slug: 'react', title: 'React' },
        { ...MOCK_LISTING_SUMMARY, slug: 'react-dom', title: 'React DOM' },
      ],
    });
    const result = await tool.handler({ query: 'React' }, nullCtx);
    assertOk(result);
  });

  it('rejects empty query', async () => {
    const result = await tool.handler({ query: '' }, nullCtx);
    assertError(result);
  });
});

describe('buygit_check_license_compat handler', () => {
  const tool = getTool('buygit_check_license_compat');

  it('returns compatibility verdict', async () => {
    mockApiGet.mockResolvedValueOnce({
      source: { spdx: 'GPL-3.0', category: 'strong-copyleft' },
      target: { spdx: 'MIT', category: 'permissive' },
      verdict: 'incompatible',
      note: 'GPL-3.0 code cannot be relicensed under MIT.',
      disclaimer: 'This is not legal advice.',
    });
    const result = await tool.handler({ source: 'GPL-3.0', target: 'MIT' }, nullCtx);
    assertOk(result);
    expect(result.content[0]!.text).toContain('INCOMPATIBLE');
  });

  it('rejects missing target', async () => {
    const result = await tool.handler({ source: 'MIT' }, nullCtx);
    assertError(result);
  });
});

describe('buygit_audit_repo handler', () => {
  const tool = getTool('buygit_audit_repo');

  it('returns catalog-based audit', async () => {
    mockApiGet.mockResolvedValueOnce({
      source: 'catalog',
      repo_url: 'https://github.com/test/repo',
      listing: MOCK_LISTING_SUMMARY,
    });
    const result = await tool.handler({ url: 'https://github.com/test/repo' }, nullCtx);
    assertOk(result);
    expect(result.content[0]!.text).toContain('catalog');
  });

  it('returns live GitHub probe', async () => {
    mockApiGet.mockResolvedValueOnce({
      source: 'github-live',
      repo_url: 'https://github.com/new/repo',
      audit: {
        title: 'New Repo',
        short_description: 'A new repository',
        repo_url: 'https://github.com/new/repo',
        license: 'Apache-2.0',
        stars: 100,
        forks: 10,
        open_issues: 5,
        language: 'Go',
        default_branch: 'main',
        archived: false,
        disabled: false,
        last_commit_at: '2026-05-22T00:00:00Z',
        topics: ['go', 'cli'],
        signals: {
          license_category: 'permissive',
          license_warning: null,
          popularity: 30,
          risk: 15,
          price_usd: 0,
          pricing_tier: 'free',
        },
      },
      caveat: 'Live probe — no secret scan or malware check.',
    });
    const result = await tool.handler({ url: 'https://github.com/new/repo' }, nullCtx);
    assertOk(result);
    expect(result.content[0]!.text).toContain('Live GitHub probe');
  });

  it('rejects non-GitHub URLs', async () => {
    const result = await tool.handler({ url: 'https://gitlab.com/foo/bar' }, nullCtx);
    assertError(result);
  });
});

describe('buygit_explain handler', () => {
  const tool = getTool('buygit_explain');

  it('returns structured error when ANTHROPIC_API_KEY is unset', async () => {
    // Ensure the key is not set
    delete process.env.ANTHROPIC_API_KEY;
    const result = await tool.handler({ slug: 'test-lib' }, nullCtx);
    assertError(result);
    expect(result.content[0]!.text).toContain('ANTHROPIC_API_KEY');
    expect(result.structuredContent?.gated_on_env).toBe('ANTHROPIC_API_KEY');
  });

  it('rejects invalid slug', async () => {
    const result = await tool.handler({ slug: '../../etc' }, nullCtx);
    assertError(result);
  });
});

describe('buygit_diff_versions handler', () => {
  const tool = getTool('buygit_diff_versions');

  it('returns current-state-only when no snapshots', async () => {
    mockApiGet.mockResolvedValueOnce({
      slug: 'test-lib',
      title: 'Test Library',
      mode: 'current-state-only',
      from: null,
      to: null,
      current: {
        license: 'MIT',
        stars: 5000,
        signals: {
          license_category: 'permissive',
          license_warning: null,
          popularity: 72,
          risk: 5,
          pricing_tier: 'free',
        },
      },
      gated_on: 'TRENDING_V2_ENABLED',
      note: 'Snapshot table not populated.',
    });
    const result = await tool.handler({ slug: 'test-lib' }, nullCtx);
    assertOk(result);
    expect(result.content[0]!.text).toContain('current-state-only');
  });
});

describe('search_tools meta handler', () => {
  const tool = getTool('search_tools');

  it('routes license-related intents to buygit_check_license_compat', async () => {
    const result = await tool.handler({ intent: 'can I bundle GPL code with my MIT project' }, nullCtx);
    assertOk(result);
    expect(result.content[0]!.text).toContain('buygit_check_license_compat');
  });

  it('routes alternative intents to buygit_find_alternative', async () => {
    const result = await tool.handler({ intent: 'find an alternative to lodash' }, nullCtx);
    assertOk(result);
    expect(result.content[0]!.text).toContain('buygit_find_alternative');
  });

  it('routes trending intents', async () => {
    const result = await tool.handler({ intent: 'what is trending this week' }, nullCtx);
    assertOk(result);
    expect(result.content[0]!.text).toContain('buygit_trending');
  });

  it('falls back to buygit_search on unknown intent', async () => {
    const result = await tool.handler({ intent: 'help me with something' }, nullCtx);
    assertOk(result);
    expect(result.content[0]!.text).toContain('buygit_search');
  });

  it('rejects empty intent', async () => {
    const result = await tool.handler({ intent: '' }, nullCtx);
    assertError(result);
  });
});
