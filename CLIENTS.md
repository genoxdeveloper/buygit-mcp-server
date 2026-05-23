# MCP client install matrix — `@buygit/mcp-server`

This file is the canonical, copy-pasteable install reference for every
MCP-capable client we test. The MCP protocol itself is universal (the
2025-11-25 spec is what every client targets), so any client that speaks
MCP works with this server — the table below pins the *config file
location* for the popular ones so you don't have to dig.

For everything else, the universal stdio config object is:

```json
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

If your client is not listed and you find the right config path, please
PR an entry to this file.

---

## Quick reference

| Client | Transport | Config location |
|---|---|---|
| [Antigravity](#antigravity-google) | stdio | settings → MCP Servers (Google, Nov 2025+) |
| [Claude Desktop](#claude-desktop-anthropic) | stdio | `claude_desktop_config.json` |
| [Claude Code](#claude-code-anthropic-cli) | stdio | `~/.claude/settings.json` or `claude mcp add` |
| [Cursor](#cursor) | stdio + HTTP | `~/.cursor/mcp.json` + one-click deeplink |
| [Cline](#cline-vs-code) | stdio | command palette → "Cline: Open MCP Servers" |
| [Codex CLI](#codex-cli-openai) | stdio | `~/.codex/mcp.json` |
| [Continue](#continue-vs-code--jetbrains) | stdio | `~/.continue/config.json` |
| [Gemini CLI](#gemini-cli-google) | stdio | `~/.gemini/mcp.json` |
| [OpenCode](#opencode-sst) | stdio | `~/.opencode/config.json` |
| [Roo Code](#roo-code-vs-code) | stdio | settings → MCP Servers |
| [Windsurf](#windsurf-codeium) | stdio | `~/.codeium/windsurf/mcp_config.json` |
| [Zed](#zed) | stdio | `settings.json` → `context_servers` |
| [Self-hosted (Docker / HTTP)](#self-hosted-streamable-http) | HTTP | any MCP 2025-03-26+ client |

---

## Antigravity (Google)

Google's agentic IDE/CLI announced 2025-11-18. MCP support shipped at
launch — the config lives in Settings → MCP Servers (UI) or in the
on-disk settings file.

```json
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

After saving, restart Antigravity. Tools appear under the agent's
"Available tools" panel; ask the agent literally `use buygit to find an
MIT-licensed react form library`.

> For the remote (Streamable HTTP) transport — useful for team-wide
> deployments — once `mcp.buygit.com` is operational, you'll be able to
> use `{ "url": "https://mcp.buygit.com/mcp" }` instead of `command`.

## Claude Desktop (Anthropic)

Edit:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

Restart Claude Desktop. The first call may take a few seconds while
`npx` resolves the package on disk.

## Claude Code (Anthropic CLI)

Two ways. Either edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

…or use the bundled `claude mcp add` command:

```bash
claude mcp add buygit -- npx -y @buygit/mcp-server@latest
```

Claude Code v2.1.76+ supports our `instructions` field, structuredContent,
icons, and the Tool Search Tool optimization that `search_tools` plugs
into.

## Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

Or use the **one-click deeplink** (Cursor 0.45+):

```
cursor://anysphere.cursor-deeplink/mcp/install?name=buygit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBidXlnaXQvbWNwLXNlcnZlckBsYXRlc3QiXX0=
```

Click it from any browser; Cursor will pop the install confirmation.

## Cline (VS Code)

Command palette → `Cline: Open MCP Servers` → paste under the top-level
`mcpServers` key:

```json
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

## Codex CLI (OpenAI)

```bash
codex mcp add buygit "npx -y @buygit/mcp-server@latest"
```

Or edit `~/.codex/mcp.json` directly with the same object shape.

## Continue (VS Code / JetBrains)

Edit `~/.continue/config.json`. Continue uses the standard MCP key:

```json
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

## Gemini CLI (Google)

Edit `~/.gemini/mcp.json`:

```json
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

Verify with `gemini --list-mcp` (lists registered servers).

## OpenCode (SST)

Edit `~/.opencode/config.json`. OpenCode wraps Anthropic Claude under
a MCP-capable terminal UI:

```json
{
  "mcp": {
    "buygit": {
      "type": "local",
      "command": ["npx", "-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

Note the `type: "local"` key — OpenCode uses a slightly different shape
than the standard `mcpServers` object.

## Roo Code (VS Code)

Fork of Cline. Same config location:

Command palette → `Roo Code: MCP Servers` → paste:

```json
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

## Windsurf (Codeium)

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "buygit": {
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

## Zed

Edit Zed's `settings.json` (CMD/Ctrl+,):

```json
{
  "context_servers": {
    "buygit": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@buygit/mcp-server@latest"]
    }
  }
}
```

Zed surfaces MCP tools as `/buygit_*` slash commands in chat.

## Self-hosted (Streamable HTTP)

For team-wide deployment behind a load balancer:

```bash
# bare metal / pm2
BUYGIT_MCP_TRANSPORT=http BUYGIT_MCP_PORT=3030 \
  npx -y @buygit/mcp-server@latest

# Docker (one-liner)
docker run --rm -p 3030:3030 \
  -e BUYGIT_MCP_TRANSPORT=http \
  -e BUYGIT_MCP_PORT=3030 \
  node:20-alpine sh -c "npx -y @buygit/mcp-server@latest"
```

Then in any MCP 2025-03-26+ client config:

```json
{
  "mcpServers": {
    "buygit": {
      "url": "http://your-internal-host:3030/mcp"
    }
  }
}
```

`/healthz` returns `{ok:true, version}` for orchestrator probes.

## Anything else

The universal stdio object at the top of this file works for any client
that follows the MCP spec. If you find the config path for a client not
listed here, please open a PR adding it.

> Issues: https://github.com/genoxdeveloper/Buygit/issues
