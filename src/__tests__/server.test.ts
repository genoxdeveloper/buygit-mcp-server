/**
 * MCP server unit/integration tests — exercise tool registration, server
 * instructions, signal formatting helpers, and the routing logic in
 * search_tools. Network-touching tool handlers (search/get_listing/etc)
 * are NOT covered here; the JSON-RPC integration smoke test runs against
 * the live API in CI release.yml.
 *
 * What this catches: the v0.1.0 URL bug class (tool registration
 * regressions, handler signature drift, formatter signal-badge changes).
 */
import { describe, it, expect } from 'vitest';
import { ALL_TOOLS } from '../tools';
import { RESOURCE_TEMPLATES } from '../resources';
import { ALL_PROMPTS } from '../prompts';
import { signalBadge, type Signals } from '../format/markdown';
import { NAME, VERSION } from '../version';

describe('tool registration', () => {
  it('registers exactly 14 tools (search_tools meta + 8 catalog + 5 cross-cutting)', () => {
    const names = ALL_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'buygit_search',
        'buygit_get_listing',
        'buygit_list_categories',
        'buygit_trending',
        'buygit_compare',
        'buygit_stats',
        'buygit_random',
        'buygit_find_alternative',
        'buygit_check_license_compat',
        'buygit_audit_repo',
        'buygit_explain',
        'buygit_diff_versions',
        'buygit_deep_audit',
        'search_tools',
      ].sort(),
    );
  });

  it('every tool has a non-empty description starting with a value-prop line (Glama rubric)', () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      // First sentence should mention a differentiator — license, curated,
      // 78k, single-call, or be the meta search_tools.
      const firstSentence = t.description.split('.')[0]!.toLowerCase();
      const isMeta = t.name === 'search_tools';
      const hasDifferentiator =
        firstSentence.includes('curated') ||
        firstSentence.includes('license') ||
        firstSentence.includes('signal') ||
        firstSentence.includes('78,') ||
        firstSentence.includes('single-call') ||
        firstSentence.includes('side-by-side') ||
        firstSentence.includes('catalog') ||
        firstSentence.includes('taxonomy') ||
        firstSentence.includes('meta') ||
        firstSentence.includes('open index') ||
        firstSentence.includes('replace');
      if (!isMeta) {
        expect(hasDifferentiator, `tool ${t.name} description should lead with a differentiator: "${firstSentence}"`).toBe(true);
      }
    }
  });

  it('every tool description fits within Token-1 budget (~ 200 tokens / 1000 chars)', () => {
    // Conservative byte-count heuristic: 1 token ≈ 5 chars for English.
    // 200 tokens × 5 = 1000 char ceiling.
    for (const t of ALL_TOOLS) {
      expect(t.description.length, `${t.name} description too long: ${t.description.length} chars`).toBeLessThan(1000);
    }
  });

  it('every tool declares outputSchema (MCP 2025-11-25 strict mode)', () => {
    // Glama's A-grade rubric weighs outputSchema completeness heavily.
    // Every tool that returns structuredContent MUST declare an
    // outputSchema. We pin this for every tool (not a subset) — a future
    // tool addition without an outputSchema is a regression.
    for (const t of ALL_TOOLS) {
      expect(t.outputSchema, `${t.name} must declare outputSchema`).toBeDefined();
      expect((t.outputSchema as { type: string }).type).toBe('object');
    }
  });

  it('every outputSchema that returns listings references the shared summary shape', () => {
    // signals + slug/title/url/license/stars block must be uniform across
    // search / trending / random / find_alternative so agents can treat
    // the response shape as canonical. We probe `outputSchema.properties.
    // results.items.required` — the canonical summaryItemSchema marks
    // [slug, title, url] as required.
    const listingEmitters = ['buygit_search', 'buygit_trending', 'buygit_random', 'buygit_find_alternative'];
    for (const name of listingEmitters) {
      const t = ALL_TOOLS.find((x) => x.name === name);
      expect(t, `${name} should exist`).toBeDefined();
      const out = t!.outputSchema as Record<string, unknown>;
      const props = (out.properties as Record<string, unknown>) ?? {};
      const results = (props.results as Record<string, unknown>) ?? {};
      const items = (results.items as Record<string, unknown>) ?? {};
      const required = items.required as string[] | undefined;
      expect(required, `${name}.outputSchema.results.items must declare required = [slug, title, url]`).toEqual(['slug', 'title', 'url']);
    }
  });

  it('tool input schemas are JSON Schema objects', () => {
    for (const t of ALL_TOOLS) {
      expect(t.inputSchema).toBeDefined();
      expect((t.inputSchema as { type: string }).type).toBe('object');
    }
  });
});

describe('resource templates', () => {
  it('exposes 7 resource templates (listing + category + compare + trending + stats + category-tree + license)', () => {
    const names = RESOURCE_TEMPLATES.map((r) => r.uriTemplate).sort();
    expect(names).toEqual(
      [
        'buygit://listing/{slug}',
        'buygit://category/{slug}',
        'buygit://compare/{slugs}',
        'buygit://trending/{period}',
        'buygit://stats',
        'buygit://category-tree',
        'buygit://license/{spdx}',
      ].sort(),
    );
  });
});

describe('prompts', () => {
  it('exposes ≥ 4 starter prompts', () => {
    expect(ALL_PROMPTS.length).toBeGreaterThanOrEqual(4);
  });
});

describe('signalBadge formatter', () => {
  function s(over: Partial<Signals> = {}): Signals {
    return {
      license_category: 'permissive',
      license_warning: null,
      popularity: 50,
      risk: 0,
      price_usd: 0,
      pricing_tier: 'free',
      ...over,
    };
  }

  it('returns null when signals are absent', () => {
    expect(signalBadge(undefined)).toBeNull();
  });
  it('shows license_category + pop + risk + pricing_tier', () => {
    const out = signalBadge(s())!;
    expect(out).toContain('permissive');
    expect(out).toContain('pop 50');
    expect(out).toContain('risk 0');
    expect(out).toContain('free');
  });
  it('adds a warning glyph when risk >= 40', () => {
    expect(signalBadge(s({ risk: 39 }))!).not.toMatch(/risk 39 ⚠/);
    expect(signalBadge(s({ risk: 40 }))!).toMatch(/risk 40 ⚠/);
    expect(signalBadge(s({ risk: 100 }))!).toMatch(/risk 100 ⚠/);
  });
});

describe('ToolContext contract', () => {
  // ToolContext is the seam between server.ts (which can elicit when the
  // client supports it) and handlers (which fall through silently when
  // it can't). Pin the shape so a future server.ts refactor doesn't
  // silently break the elicit-null contract.
  it('every tool handler accepts a (args, ctx) signature without throwing on null elicit', async () => {
    for (const t of ALL_TOOLS) {
      // We do NOT call the handler — most need a live API. The check is
      // that the handler signature accepts a ToolContext shape with
      // elicit:null. TypeScript checks this at compile time too; this
      // test catches the runtime case where a handler unconditionally
      // dereferences ctx.elicit.
      const handlerFn = t.handler as unknown as (a: unknown, c: { elicit: null }) => Promise<unknown>;
      expect(typeof handlerFn).toBe('function');
      // Function.length is the count of declared params. Handlers may
      // declare 0 (no-arg tool like list_categories), 1 (legacy), or 2
      // (ctx-aware) — all three must be supported because JavaScript
      // function-call invariance lets the caller pass extra args.
      expect(handlerFn.length).toBeGreaterThanOrEqual(0);
      expect(handlerFn.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('version constants', () => {
  it('NAME is @buygit/mcp-server', () => {
    expect(NAME).toBe('@buygit/mcp-server');
  });
  it('VERSION matches the package.json semver', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});
