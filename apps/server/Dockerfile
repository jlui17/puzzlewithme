# Build from repo root so every Bun workspace manifest is in scope. Keep this
# pin aligned with .mise.toml and package.json.
FROM oven/bun:1.3.14-slim AS bun
FROM node:24-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Manifests first so dependency install caches independently of source edits.
# Root trustedDependencies allows native install scripts for SQLite and sharp.
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/geometry/package.json packages/geometry/
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY apps/server ./apps/server

# Run from package dir because SQLite and image paths are cwd-relative.
WORKDIR /app/apps/server
ENV NODE_ENV=production
EXPOSE 3001
CMD ["bun", "run", "start"]
