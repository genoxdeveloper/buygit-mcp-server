import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  minify: true,
  shims: false,
  splitting: false,
  bundle: true,
  // Keep the shebang on the entry so `npx @buygit/mcp-server` works
  // without an extra wrapper script.
  banner: { js: '#!/usr/bin/env node' },
  // The MCP SDK ships ESM — bundling lets us ship a single-file binary
  // that has zero cold-start install delay under `npx`.
});
