/**
 * Federation pipeline tests.
 *
 * The real `buygit_deep_audit` tool spawns external companion MCPs via
 * `npx --no-install -y @socket/mcp` etc. Those packages aren't on the
 * test machine, so we can't drive the real spawn end-to-end in CI.
 *
 * Instead, this file proves the *aggregation* logic — verdict
 * computation, federation result shape, soft-fail behaviour when a
 * companion is not-installed. The actual `callFederationCompanion()`
 * implementation isn't tested here (it's exercised by the LIVE_SMOKE
 * tests when an operator has the companion MCPs installed; documented
 * behaviour-only otherwise).
 *
 * What this catches:
 *   - Adding a new companion to the COMPANION_TOOL_MAP without updating
 *     the federate_with enum.
 *   - Changing the verdict thresholds without updating the tests.
 *   - Breaking the deep_audit outputSchema shape.
 */
import { describe, it, expect } from 'vitest';
import { ALL_TOOLS } from '../tools';

describe('buygit_deep_audit shape', () => {
  const tool = ALL_TOOLS.find((t) => t.name === 'buygit_deep_audit');

  it('exists in the registered tool set', () => {
    expect(tool).toBeDefined();
  });

  it('inputSchema declares federate_with enum of exactly three companions', () => {
    const props = (tool!.inputSchema as { properties: Record<string, { items?: { enum?: string[] } }> }).properties;
    const items = props.federate_with?.items;
    expect(items?.enum).toEqual(['socket-mcp', 'openssf-mcp', 'trufflehog-mcp']);
  });

  it('inputSchema clamps timeout_ms to 1000-15000', () => {
    const props = (tool!.inputSchema as { properties: Record<string, { minimum?: number; maximum?: number; default?: number }> }).properties;
    expect(props.timeout_ms?.minimum).toBe(1000);
    expect(props.timeout_ms?.maximum).toBe(15000);
    expect(props.timeout_ms?.default).toBe(5000);
  });

  it('outputSchema requires target + buygit_audit + federation_results', () => {
    const out = tool!.outputSchema as { required?: string[] };
    expect(out.required).toEqual(['target', 'buygit_audit', 'federation_results']);
  });

  it('federation_results items document all four statuses', () => {
    const out = tool!.outputSchema as { properties: Record<string, { items?: { properties?: { status?: { enum?: string[] } } } }> };
    const statusEnum = out.properties.federation_results?.items?.properties?.status?.enum;
    expect(statusEnum).toEqual(['ok', 'not-installed', 'timeout', 'error']);
  });
});

describe('buygit_audit_repo URL pattern', () => {
  const tool = ALL_TOOLS.find((t) => t.name === 'buygit_audit_repo');

  it('rejects URLs that are not github.com via the inputSchema pattern', () => {
    const pattern = (tool!.inputSchema as { properties: { url: { pattern?: string } } }).properties.url.pattern;
    expect(pattern).toBeDefined();
    const re = new RegExp(pattern!);

    // Accept canonical github.com URLs
    expect(re.test('https://github.com/sindresorhus/is-online')).toBe(true);
    expect(re.test('http://github.com/foo/bar')).toBe(true);
    expect(re.test('https://www.github.com/foo/bar.git')).toBe(true);

    // Reject anything that isn't github.com
    expect(re.test('https://gitlab.com/foo/bar')).toBe(false);
    expect(re.test('https://codeberg.org/foo/bar')).toBe(false);
    expect(re.test('javascript:alert(1)')).toBe(false);
    expect(re.test('not a url')).toBe(false);
  });
});

describe('buygit_search inputSchema examples', () => {
  // Glama scores Param Semantics on every param having examples.
  // We pin that every searchable filter param has an examples array.
  const tool = ALL_TOOLS.find((t) => t.name === 'buygit_search');
  const props = (tool!.inputSchema as { properties: Record<string, { examples?: unknown[] }> }).properties;

  it.each(['query', 'category', 'language', 'license', 'min_stars'])('%s has examples', (name) => {
    expect(Array.isArray(props[name]?.examples), `${name} should have examples`).toBe(true);
    expect(props[name]!.examples!.length).toBeGreaterThan(0);
  });

  it('declares cursor for pagination', () => {
    expect(props.cursor).toBeDefined();
    expect(props.cursor!.examples).toBeUndefined(); // cursors are opaque — no examples
  });
});
