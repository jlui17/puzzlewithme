# Build from repo root so every Bun workspace manifest and shared package is
# in scope. Keep this pin aligned with .mise.toml and package.json.
FROM oven/bun:1.3.14-slim AS bun
FROM node:24-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/geometry/package.json packages/geometry/
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY apps/web ./apps/web

# Next bakes both values into the production output during build.
ARG NEXT_PUBLIC_SERVER_URL
ARG SERVER_INTERNAL_URL
ENV NEXT_PUBLIC_SERVER_URL=$NEXT_PUBLIC_SERVER_URL \
    SERVER_INTERNAL_URL=$SERVER_INTERNAL_URL

WORKDIR /app/apps/web
RUN bun run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "start"]
