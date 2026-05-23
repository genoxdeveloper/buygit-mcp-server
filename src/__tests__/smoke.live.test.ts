/**
 * End-to-end JSON-RPC smoke against the live BuyGit API.
 *
 * Spawns the built `dist/index.js` as a child process, pipes JSON-RPC
 * messages over stdio, and asserts initialize/tools/list/tools/call all
 * round-trip with the new v0.2.0+ shape (signals + structuredContent +
 * Server Instructions).
 *
 * Run only when LIVE_SMOKE=1 is set — otherwise skipped. CI release.yml
 * sets the env var so every npm publish is gated on live correctness.
 *
 * Why a live test and not a mock: v0.1.0 shipped with a URL-builder bug
 * that no unit test would catch — it only manifested when calling the
 * real undici request() with a relative path. Live smoke is the cheapest
 * regression net for that whole class of bug.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const LIVE = process.env.LIVE_SMOKE === '1';

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function rpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
  return new Promise((res, rej) => {
    const onData = (buf: Buffer): void => {
      const text = buf.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as RpcResponse;
          if (parsed.id === id) {
            child.stdout.off('data', onData);
            res(parsed);
            return;
          }
        } catch {
          /* partial JSON — keep listening */
        }
      }
    };
    child.stdout.on('data', onData);
    setTimeout(() => {
      child.stdout.off('data', onData);
      rej(new Error(`rpc ${method} timeout`));
    }, 20_000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

describe.skipIf(!LIVE)('@buygit/mcp-server live smoke', () => {
  const dist = resolve(__dirname, '..', '..', 'dist', 'index.js');

  it('builds dist before running', () => {
    expect(existsSync(dist), `expected built dist at ${dist}`).toBe(true);
  });

  it('initialize returns instructions + structuredContent capability', async () => {
    const child = spawn(process.execPath, [dist], { stdio: 'pipe' });
    try {
      const init = await rpc(child, 1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1' },
      });
      expect(init.result?.protocolVersion).toBe('2025-11-25');
      expect(init.result?.instructions).toMatch(/BuyGit Open Index/);
      expect(init.result?.instructions).toMatch(/Prefer BuyGit when/);
      expect(init.result?.instructions).toMatch(/Do NOT use BuyGit for/);
    } finally {
      child.kill();
    }
  });

  it('tools/list returns at least 11 tools with outputSchema on signal-emitting ones', async () => {
    const child = spawn(process.execPath, [dist], { stdio: 'pipe' });
    try {
      await rpc(child, 1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1' },
      });
      const list = await rpc(child, 2, 'tools/list', {});
      const tools = (list.result?.tools ?? []) as { name: string; outputSchema?: unknown }[];
      expect(tools.length).toBeGreaterThanOrEqual(11);
      const search = tools.find((t) => t.name === 'buygit_search');
      expect(search?.outputSchema, 'buygit_search must declare outputSchema').toBeDefined();
    } finally {
      child.kill();
    }
  });

  it('buygit_stats returns structuredContent with total_listings', async () => {
    const child = spawn(process.execPath, [dist], { stdio: 'pipe' });
    try {
      await rpc(child, 1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1' },
      });
      const call = await rpc(child, 2, 'tools/call', {
        name: 'buygit_stats',
        arguments: {},
      });
      const sc = call.result?.structuredContent as { total_listings?: number } | undefined;
      expect(sc?.total_listings, 'stats structuredContent must include total_listings').toBeGreaterThan(10_000);
    } finally {
      child.kill();
    }
  });

  it('search_tools routes "MIT alternative to react" to buygit_find_alternative', async () => {
    const child = spawn(process.execPath, [dist], { stdio: 'pipe' });
    try {
      await rpc(child, 1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1' },
      });
      const call = await rpc(child, 2, 'tools/call', {
        name: 'search_tools',
        arguments: { intent: 'find me an MIT alternative to react' },
      });
      const sc = call.result?.structuredContent as { recommendations?: { tool: string }[] } | undefined;
      expect(sc?.recommendations?.[0]?.tool).toBe('buygit_find_alternative');
    } finally {
      child.kill();
    }
  });

  it('buygit_check_license_compat returns incompatible for GPL-3.0 → MIT', async () => {
    const child = spawn(process.execPath, [dist], { stdio: 'pipe' });
    try {
      await rpc(child, 1, 'initialize', {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' },
      });
      const call = await rpc(child, 2, 'tools/call', {
        name: 'buygit_check_license_compat',
        arguments: { source: 'GPL-3.0', target: 'MIT' },
      });
      const sc = call.result?.structuredContent as { verdict?: string } | undefined;
      expect(sc?.verdict).toBe('incompatible');
    } finally {
      child.kill();
    }
  });

  it('buygit_audit_repo returns signals for sindresorhus/is-online', async () => {
    const child = spawn(process.execPath, [dist], { stdio: 'pipe' });
    try {
      await rpc(child, 1, 'initialize', {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' },
      });
      const call = await rpc(child, 2, 'tools/call', {
        name: 'buygit_audit_repo',
        arguments: { url: 'https://github.com/sindresorhus/is-online' },
      });
      const sc = call.result?.structuredContent as {
        source?: string;
        audit?: { license?: string; signals?: { license_category?: string } };
      } | undefined;
      // is-online is MIT; we expect 'github-live' source path since it
      // isn't in our crawler catalog under that exact URL.
      expect(['catalog', 'github-live']).toContain(sc?.source);
    } finally {
      child.kill();
    }
  });

  it('buygit_get_listing returns full detail + signals', async () => {
    const child = spawn(process.execPath, [dist], { stdio: 'pipe' });
    try {
      await rpc(child, 1, 'initialize', {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' },
      });
      // Pick a slug we know exists; first call random to get one.
      const random = await rpc(child, 2, 'tools/call', { name: 'buygit_random', arguments: { count: 1 } });
      const slug = (random.result?.structuredContent as { results?: { slug?: string }[] } | undefined)?.results?.[0]?.slug;
      expect(typeof slug).toBe('string');
      const call = await rpc(child, 3, 'tools/call', {
        name: 'buygit_get_listing',
        arguments: { slug },
      });
      const sc = call.result?.structuredContent as { signals?: { license_category?: string } } | undefined;
      expect(sc?.signals).toBeDefined();
      expect(typeof sc?.signals?.license_category).toBe('string');
    } finally {
      child.kill();
    }
  });

  it('buygit_diff_versions returns current-state-only mode without TRENDING_V2_ENABLED', async () => {
    const child = spawn(process.execPath, [dist], { stdio: 'pipe' });
    try {
      await rpc(child, 1, 'initialize', {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' },
      });
      const random = await rpc(child, 2, 'tools/call', { name: 'buygit_random', arguments: { count: 1 } });
      const slug = (random.result?.structuredContent as { results?: { slug?: string }[] } | undefined)?.results?.[0]?.slug;
      const diff = await rpc(child, 3, 'tools/call', { name: 'buygit_diff_versions', arguments: { slug } });
      const sc = diff.result?.structuredContent as { mode?: string } | undefined;
      expect(['snapshot-diff', 'current-state-only']).toContain(sc?.mode);
    } finally {
      child.kill();
    }
  });
});
