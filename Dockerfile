# Dockerfile for Glama evaluation and self-hosting
# Glama uses this to build, start, and introspect the MCP server.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@latest --activate \
    && pnpm install --frozen-lockfile 2>/dev/null || pnpm install
COPY tsconfig.json tsup.config.ts ./
COPY src/ ./src/
RUN pnpm build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
# Default: stdio transport (Glama introspection).
# Set BUYGIT_MCP_TRANSPORT=http for Streamable HTTP on port 4100.
ENV NODE_ENV=production
EXPOSE 4100
CMD ["node", "dist/index.js"]
