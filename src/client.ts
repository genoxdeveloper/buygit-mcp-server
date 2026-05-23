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

/**
 * P2-7: Timeout is configurable via env var. Raised default from 12s
 * to 15s to accommodate cold-start scenarios on Railway / serverless.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.BUYGIT_TIMEOUT_MS) || 15_000;

/**
 * P2-3: Track which base URL the pool was created for. When the env
 * var changes (e.g. operator hot-swaps to a mirror), the next request
 * transparently re-creates the pool.
 */
let pool: Pool | null = null;
let poolBase: string | null = null;

function ensurePool(base: string): Pool {
  if (pool === null || poolBase !== base) {
    // Close the old pool gracefully if switching bases.
    if (pool !== null) {
      pool.close().catch(() => { /* best-effort */ });
    }
    pool = new Pool(base, {
      connections: 4,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    });
    poolBase = base;
  }
  return pool;
}

export interface ApiCallOptions {
  /** Per-request timeout in ms (default from BUYGIT_TIMEOUT_MS or 15s). */
  timeoutMs?: number;
  /** Max retry attempts for transient errors (default 3). */
  maxRetries?: number;
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

/**
 * Retry helper with exponential backoff for transient failures.
 * Retries on: 429 (rate-limited), 503 (service unavailable),
 * ECONNRESET, ETIMEDOUT, UND_ERR_SOCKET.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof BuygitApiError) {
    return err.status === 429 || err.status === 503;
  }
  if (err instanceof Error) {
    return /ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT/i.test(err.message);
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function apiGet<T>(
  path: string,
  query: Record<string, string | number | boolean | undefined | null> = {},
  opts: ApiCallOptions = {},
): Promise<T> {
  const base = DEFAULT_BASE;
  const maxRetries = opts.maxRetries ?? 3;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await _doGet<T>(base, path, query, timeout);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isRetryable(err)) {
        // Exponential backoff: 200ms, 600ms, 1800ms
        const delayMs = 200 * Math.pow(3, attempt);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function _doGet<T>(
  base: string,
  path: string,
  query: Record<string, string | number | boolean | undefined | null>,
  timeoutMs: number,
): Promise<T> {
  const p = ensurePool(base);
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const fullPath = qs ? `${path}?${qs}` : path;

  const res = await p.request({
    method: 'GET',
    path: fullPath,
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
    },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
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

