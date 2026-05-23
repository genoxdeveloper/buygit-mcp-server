/**
 * Entry point. Spawned by Claude Desktop / Cursor / Cline as a child
 * process; communicates over stdio JSON-RPC by default.
 *
 * Use `BUYGIT_MCP_TRANSPORT=http` + `BUYGIT_MCP_PORT=3030` to switch to
 * Streamable HTTP for self-hosted / remote MCP deployments. The HTTP
 * mode binds 0.0.0.0:$PORT and serves /mcp (POST + optional GET for SSE)
 * per the MCP 2025-03-26 transport spec. The transport is stateless by
 * default (no session ID) so it can sit behind any L7 load balancer.
 *
 * stdout is reserved for the MCP protocol — every log line goes to
 * stderr so Claude Desktop's log viewer can surface them without
 * corrupting the JSON-RPC stream.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBuygitServer } from './server.js';
import { ALL_TOOLS } from './tools.js';
import { NAME, VERSION } from './version.js';

function log(...args: unknown[]): void {
  // stderr-only logging — never stdout, which is the MCP protocol channel.
  process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
}

async function startStdio(): Promise<void> {
  const server = createBuygitServer();
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  log(`[${NAME}@${VERSION}] connected via stdio`);
}

async function startHttp(port: number, host: string): Promise<void> {
  // Truly stateless Streamable HTTP — each POST /mcp gets a fresh
  // server+transport pair so every request can start with "initialize".
  // This is required for Smithery gateway and any proxy that doesn't
  // maintain session affinity.

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Liveness — health checks before MCP handshake.
    if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: NAME, version: VERSION }));
      return;
    }

    // /.well-known/mcp/server-card.json — Smithery discovery metadata
    // Including `tools` lets Smithery skip the live MCP scan entirely.
    if (req.method === 'GET' && req.url === '/.well-known/mcp/server-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: NAME,
        version: VERSION,
        description: 'Browse, search, and manage BuyGit digital-goods marketplace via MCP',
        homepage: 'https://github.com/genoxdeveloper/buygit-mcp-server',
        transport: { type: 'streamable-http', url: '/mcp' },
        tools: ALL_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }));
      return;
    }

    // Permissive CORS for browsers + ChatGPT Apps SDK. The MCP surface is
    // read-only with no cookies, so wide-open is safe.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, mcp-session-id, accept');
    res.setHeader('access-control-expose-headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', code: 'NOT_FOUND' }));
      return;
    }

    try {
      // Per-request server+transport: truly stateless, every request
      // can start with "initialize" without conflicting with prior sessions.
      const server = createBuygitServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log(`[${NAME}@${VERSION}] http handler error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error', code: 'INTERNAL' }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });
  log(`[${NAME}@${VERSION}] Streamable HTTP listening on http://${host}:${port}/mcp`);

  // Clean shutdown — important for orchestrators that send SIGTERM.
  function shutdown(signal: NodeJS.Signals): void {
    log(`[${NAME}@${VERSION}] received ${signal} — shutting down`);
    httpServer.close(() => process.exit(0));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const transport = (process.env.BUYGIT_MCP_TRANSPORT ?? 'stdio').toLowerCase();

  if (transport === 'stdio') {
    await startStdio();
    return;
  }

  if (transport === 'http') {
    const port = Number(process.env.PORT ?? process.env.BUYGIT_MCP_PORT ?? 3030);
    const host = process.env.BUYGIT_MCP_HOST ?? '0.0.0.0';
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      log(`[${NAME}@${VERSION}] invalid PORT/BUYGIT_MCP_PORT="${port}"`);
      process.exit(2);
    }
    await startHttp(port, host);
    return;
  }

  log(`[${NAME}@${VERSION}] unknown transport "${transport}". Set BUYGIT_MCP_TRANSPORT to "stdio" (default) or "http".`);
  process.exit(2);
}

main().catch((err) => {
  log(`[${NAME}@${VERSION}] fatal: ${(err as Error).message}`);
  process.exit(1);
});
