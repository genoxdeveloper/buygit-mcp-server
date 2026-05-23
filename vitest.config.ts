import { defineConfig } from 'vitest/config';

// The repo-root vitest.config.ts is tuned for the React app (jsdom + a
// frontend setup file). The MCP server is plain Node and has no DOM, so
// it ships its own minimal config to avoid pulling that setup in.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.{test,spec}.ts'],
    testTimeout: 30_000,
  },
});
