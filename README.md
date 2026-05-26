# @buygit/mcp-server

[![buygit-mcp-server MCP server](https://glama.ai/mcp/servers/genoxdeveloper/buygit-mcp-server/badges/card.svg)](https://glama.ai/mcp/servers/genoxdeveloper/buygit-mcp-server)

> The only MCP that returns **license + supply-chain risk + popularity + price in a single call**. 78,094 curated Git assets. Zero config. MIT. Free forever.

MCP server for the **BuyGit Open Index** — 78,094 curated, deduplicated, license-tagged Git assets from GitHub, Codeberg, npm, crates.io, WordPress, HuggingFace, and 17 other sources — to Claude Desktop, Cursor, Cline, Continue, ChatGPT Apps SDK, and any MCP 2025-11-25 client.

[![npm](https://img.shields.io/npm/v/@buygit/mcp-server.svg)](https://www.npmjs.com/package/@buygit/mcp-server)
[![license](https://img.shields.io/npm/l/@buygit/mcp-server.svg)](https://github.com/genoxdeveloper/buygit-mcp-server/blob/main/LICENSE)

> Companion: **[`@buygit/cli`](https://www.npmjs.com/package/@buygit/cli)** — same answers from your shell. `npx @buygit/cli search "react form" --license MIT`.
>
> Companion: **`buygit-vscode` extension** — license-compat + audit from the VS Code command palette + explorer right-click. See [`packages/vscode-extension`](../vscode-extension).
>
> Works in **Antigravity, Claude Desktop, Claude Code, Cursor, Cline, Codex CLI, Continue, Gemini CLI, OpenCode, Roo Code, Windsurf, Zed**, and any MCP 2025-11-25 client. Full install matrix in **[CLIENTS.md](./CLIENTS.md)**.
>
> **Cursor one-click install:** [`cursor://anysphere.cursor-deeplink/mcp/install?name=buygit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBidXlnaXQvbWNwLXNlcnZlckBsYXRlc3QiXX0=`](cursor://anysphere.cursor-deeplink/mcp/install?name=buygit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBidXlnaXQvbWNwLXNlcnZlckBsYXRlc3QiXX0=)

## What is BuyGit?

**[BuyGit](https://buygit.com)** is an open marketplace and discovery platform for Git-based digital products — source code, templates, SaaS starters, boilerplates, plugins, AI agents, ML models, and developer tools.

Unlike raw GitHub search, BuyGit **curates, deduplicates, and enriches** every listing with structured metadata:

- **License classification** — SPDX identifier + category (permissive / weak-copyleft / strong-copyleft / proprietary) + plain-English compatibility warnings
- **Supply-chain risk scoring** — 0-100 composite score based on dependency hygiene, secret scan status, malware flags, and maintenance signals
- **Popularity scoring** — log-scaled 0-100 star score normalized across sources (GitHub, npm, crates.io, etc.)
- **Pricing tier** — free vs. paid, with USD price for premium listings
- **Repository health** — stars, forks, language, last commit date, archived/disabled status, upstream health

The catalog currently indexes **78,094 crawler-imported listings** from 17+ sources, with continuous crawling adding new assets daily. BuyGit also supports seller-curated premium listings (marketplace), but the MCP server exposes only the public crawler-imported catalog — no auth required.

**Key URLs:**
- 🌐 Main site: [buygit.com](https://buygit.com)
- 📖 MCP landing page: [buygit.com/mcp](https://buygit.com/mcp)
- 📋 API spec: [buygit.com/api/v1/crawler/openapi.json](https://buygit.com/api/v1/crawler/openapi.json)

## Why BuyGit over raw GitHub search?

Every tool returns a 4-axis signals block — the differentiator. No other MCP gives you this in one call.

```json
{
  "license_category": "permissive",
  "license_warning": null,
  "popularity": 75,
  "risk": 0,
  "price_usd": 0,
  "pricing_tier": "free"
}
```

| User question | github-mcp | Smithery code-search | context7 | Socket MCP | **BuyGit MCP** |
|---|:-:|:-:|:-:|:-:|:-:|
| "MIT-compatible image diff library" | raw search, no license | raw search | docs only | safety only | **license-filtered** |
| "Is this dependency safe to bundle?" | — | — | — | Socket score | **Socket + popularity + license fused** |
| "Compare A vs B by license + activity" | 4+ calls | 4+ calls | — | — | **1 call** |
| "Alternative to GPL X, but MIT-only" | — | — | — | — | **`buygit_find_alternative`** |
| "Is GPL-3.0 safe in my MIT project?" | — | — | — | — | **`license_warning` field** |
| "Explain this listing for me" | — | — | — | — | **`buygit_explain` (AI summary)** |
| "Deep audit with companion MCPs" | manual | — | — | separate | **`buygit_deep_audit` (federation)** |

We also tell you when **NOT** to use us — see [WHEN_NOT_TO_USE.md](./WHEN_NOT_TO_USE.md).

## What you get

**14 tools, 7 resource templates, 4 prompts** — all backed by the public, read-only, **free-forever** [BuyGit Open Index API](https://buygit.com/api/v1/crawler/openapi.json). Full client install matrix in [CLIENTS.md](./CLIENTS.md) (13 clients).

| Tool | One-line value |
|---|---|
| `buygit_search` | Curated, license-tagged, risk-scored search across 78,094 assets. `fields=` sparse fieldset + `summary_mode=compact` for token savings. |
| `buygit_get_listing` | Replaces 3 separate MCP calls — license + risk + popularity + repo signals + similar in one shot |
| `buygit_list_categories` | Full taxonomy with per-category counts |
| `buygit_trending` | Curated trending (not GitHub Trending noise), license-aware |
| `buygit_compare` | Single-call 2-5 way comparison with license_warning |
| `buygit_stats` | Catalog meta — totals by license, category, source, plus data_freshness |
| `buygit_random` | Surprise me — license + risk badges on every pick |
| `buygit_find_alternative` | License-filtered, risk-scored alternatives — the answer GitHub search cannot give |
| `buygit_check_license_compat` | "Is GPL-3 safe in my MIT project?" Returns compatible / review / incompatible with note. The only MCP that answers this without a separate SCA tool. |
| `buygit_audit_repo` | Audit any external GitHub repo URL — same 4-axis signals as catalog rows, via live GitHub probe. Falls back to richer cached signals when URL is in our index. |
| `buygit_explain` | **v0.9.0** · AI-powered listing summary (overview / license / risk / usage focus). Gated on `ANTHROPIC_API_KEY`. Uses Claude Haiku for cost-efficient summaries. |
| `buygit_diff_versions` | **v0.9.0** · Time-window signal diff — shows how a listing's license, popularity, and risk changed between snapshots. |
| `buygit_deep_audit` | **v0.9.0** · Federated deep audit — chains Socket, OpenSSF Scorecard, and TruffleHog companion MCPs alongside BuyGit's own signals for a comprehensive security audit. |
| `search_tools` | Meta routing tool — give it a plain-English intent, get the ranked tool to call next. MCP Tool Search Tool semantic. |

Resources let you @-mention a listing, category, comparison, or any cacheable static asset and have it attached as conversation context — no tools/call required:

- `buygit://listing/{slug}` — full listing detail with 4-axis signals
- `buygit://category/{slug}` — category top 20
- `buygit://compare/{slug-a}+{slug-b}+{slug-c}` — single-fetch 2-5 way compare
- `buygit://trending/{period}` — day/week/month trending, pin once and re-reference
- `buygit://stats` — catalog meta + data_freshness, pin to know catalog scale
- `buygit://category-tree` — full taxonomy lookup table
- `buygit://license/{spdx}` — compatibility matrix row for any SPDX id

Prompts (slash-menu in Claude Desktop):
- `starter_for_stack` — "Find me a starter kit for {stack}"
- `alternative_to` — "Alternatives to {repo}"
- `audit_my_dependency` — "Is {slug} safe to ship?"
- `explore_category` — "What's hot in {category}?"

## Install

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```jsonc
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

Restart Claude Desktop. The first tool call may take a few seconds while `npx` resolves the package.

### Cursor

Edit `~/.cursor/mcp.json`:

```jsonc
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

### Cline (VS Code extension)

Open the Cline MCP settings (`Cline: Open MCP Servers` from the command palette) and add:

```jsonc
{
  "buygit": {
    "command": "npx",
    "args": ["-y", "@buygit/mcp-server@latest"]
  }
}
```

### Continue

Continue picks up MCP servers from `~/.continue/config.json`:

```jsonc
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

### Self-hosted via Docker

```bash
docker run -i --rm ghcr.io/buygit/mcp-server:latest
```

The container runs stdio MCP. Pipe stdin/stdout from your client.

## Try it

After you've added the config and restarted your client, ask:

- _"Find me a Next.js SaaS starter under MIT with more than 500 stars."_
- _"What's trending in AI agents this week on BuyGit?"_
- _"Tell me about `next-saas-starter-pro` — is the secret scan clean?"_
- _"Compare `react-saas-template` and `nextjs-stripe-starter`."_
- _"Explain the license risk of `some-gpl-library` for my MIT project."_
- _"Run a deep audit on github.com/some-org/some-repo."_

The model will call the right tools, attach the canonical BuyGit links, and let you click through.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `BUYGIT_API_BASE` | `https://buygit.com` | Override for staging / self-hosted mirror |
| `BUYGIT_MCP_TRANSPORT` | `stdio` | `stdio` (default, all clients) · `http` (Streamable HTTP) |
| `BUYGIT_TIMEOUT_MS` | `15000` | Per-request timeout in milliseconds. Increase for slow networks. |
| `BUYGIT_EXPLAIN_MODEL` | `claude-haiku-4-5-20251001` | Anthropic model for `buygit_explain` summaries. |
| `ANTHROPIC_API_KEY` | _(none)_ | Required only for `buygit_explain`. All other tools work without any key. |
| `BUYGIT_COMPANION_TOOL_MAP` | _(built-in)_ | JSON override for companion MCP tool names in `buygit_deep_audit`. |

## Architecture

```
┌─────────────────────────────────────────────┐
│  AI Agent (Claude, GPT, Gemini, …)          │
│  ↕ MCP JSON-RPC (stdio or Streamable HTTP)  │
├─────────────────────────────────────────────┤
│  @buygit/mcp-server                         │
│  14 tools · 7 resources · 4 prompts         │
│  Zod input validation · structuredContent   │
│  Retry w/ exponential backoff (429/503)     │
├─────────────────────────────────────────────┤
│  undici Pool → buygit.com REST API          │
│  Public · Read-only · No auth · Free        │
└─────────────────────────────────────────────┘
```

## Privacy & licensing

The BuyGit Open Index API is **public, read-only, no auth**. There is no key to install. Requests are not personally identifiable (the server doesn't log the queries you make).

The catalog excludes seller-curated listings — only crawler-imported public-repo metadata is exposed. Each result includes a `url` field linking back to the canonical BuyGit page; please surface that link when redistributing.

This package is MIT licensed. The API responses are licensed for indexing + attribution per the [BuyGit API terms](https://buygit.com/api-docs/crawler).

## Links

- BuyGit main site: <https://buygit.com>
- BuyGit MCP landing page: <https://buygit.com/mcp>
- OpenAPI 3.1 spec: <https://buygit.com/api/v1/crawler/openapi.json>
- Source: <https://github.com/genoxdeveloper/buygit-mcp-server>
- Issues: <https://github.com/genoxdeveloper/buygit-mcp-server/issues>
- npm: <https://www.npmjs.com/package/@buygit/mcp-server>

## Develop

```bash
cd packages/mcp-server
pnpm install
pnpm build
node dist/index.js   # connects on stdio — feed it MCP JSON-RPC over stdin
```

Or run the watch build while developing:

```bash
pnpm dev
```

Run tests:

```bash
pnpm test           # 57 tests (handler + server + federation)
```

To smoke-test against the live API:

```bash
BUYGIT_API_BASE=https://buygit.com node dist/index.js
# then in another process, send a `tools/list` JSON-RPC frame
```
