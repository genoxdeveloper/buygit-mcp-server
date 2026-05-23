/**
 * Thin HTTP client over the public BuyGit Open Index REST API.
 *
 * Why undici instead of native fetch?
 *   - Keep-alive connection pool out of the box (lower latency on
 *     consecutive tool calls).
 *   - Predictable timeouts.
 *
 * Auth: none. The /api/v1/crawler/* surface is public read-only.
 *
 * the MCP server at a self-hosted mirror:
 *   BUYGIT_API_BASE=https://your-buygit-mirror.example.com
 */
import { Pool } from 'undici';
import { VERSION } from './version.js';

const DEFAULT_BASE = process.env.BUYGIT_API_BASE || 'https://buygit.com';
const USER_AGENT = `@buygit/mcp-server/${VERSION} (+https://buygit.com/mcp)`;

let pool: Pool | null = null;
function ensurePool(base: string): Pool {
  if (pool === null) {
    pool = new Pool(base, {
      connections: 4,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    });
  }
  return pool;
}

export interface ApiCallOptions {
  /** Per-request timeout in ms (default 12s). */
  timeoutMs?: number;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  meta?: { request_id?: string; ts?: string };
}

export class BuygitApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'BuygitApiError';
  }
}

export async function apiGet<T>(
  path: string,
  query: Record<string, string | number | boolean | undefined | null> = {},
  opts: ApiCallOptions = {},
): Promise<T> {
  const base = DEFAULT_BASE;
  const p = ensurePool(base);
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const fullPath = qs ? `${path}?${qs}` : path;

  // undici Pool: call .request() on the dispatcher with `path` (origin
  // baked into the pool). Earlier draft used the top-level `request(url)`
  // helper with a relative path which throws ERR_INVALID_URL — the helper
  // expects an absolute URL even when a dispatcher is supplied.
  const res = await p.request({
    method: 'GET',
    path: fullPath,
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
    },
    headersTimeout: opts.timeoutMs ?? 12_000,
    bodyTimeout: opts.timeoutMs ?? 12_000,
  });

  const status = res.statusCode;
  const text = await res.body.text();

  let parsed: ApiEnvelope<T> | null = null;
  try {
    parsed = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    throw new BuygitApiError(`upstream returned non-JSON (status ${status})`, status);
  }

  if (status >= 400 || parsed.ok === false) {
    throw new BuygitApiError(
      parsed.error ?? `upstream returned HTTP ${status}`,
      status,
      parsed.code,
    );
  }

  // Endpoints in BuyGit wrap responses in an envelope { ok, data, meta }.
  // Return the data payload directly.
  if (parsed.data !== undefined) return parsed.data;
  // Some endpoints return the data at the top level (e.g. openapi.json).
  return parsed as unknown as T;
}
