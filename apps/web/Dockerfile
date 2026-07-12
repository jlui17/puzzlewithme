# Build from the repo root (docker-compose sets context: .) so the pnpm
# workspace manifests and the transpiled workspace packages are in scope.
#
# node:24-slim for parity with the server image; the web app has no native
# deps of its own.
FROM node:24-slim

# Pinned to package.json's packageManager field (see server Dockerfile for why
# npm over corepack).
RUN npm install -g pnpm@11.10.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/geometry/package.json packages/geometry/

RUN pnpm install --frozen-lockfile --filter @puzzlewithme/web...

COPY packages ./packages
COPY apps/web ./apps/web

# Both must be set at BUILD time, not just runtime: `next build` inlines
# NEXT_PUBLIC_SERVER_URL into the client bundle (it becomes the browser's
# wss:// origin), and bakes the rewrites() destinations (SERVER_INTERNAL_URL,
# the game server's in-network address) into the routes manifest.
ARG NEXT_PUBLIC_SERVER_URL
ARG SERVER_INTERNAL_URL
ENV NEXT_PUBLIC_SERVER_URL=$NEXT_PUBLIC_SERVER_URL \
    SERVER_INTERNAL_URL=$SERVER_INTERNAL_URL

WORKDIR /app/apps/web
RUN pnpm build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "start"]
