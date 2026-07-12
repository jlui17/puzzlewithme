# Build from the repo root (docker-compose sets context: .) so the pnpm
# workspace manifests and the two workspace packages the server depends on are
# in scope.
#
# node:24-slim: matches the Node the repo develops on (engines >=20), and slim
# glibc is what better-sqlite3 and sharp ship prebuilt binaries for, so no
# compiler toolchain is needed in the image.
FROM node:24-slim

# Pinned to package.json's packageManager field. Installed via npm instead of
# corepack because corepack is deprecated in current Node images and its
# registry-signature checks have broken pinned installs before.
RUN npm install -g pnpm@11.10.0

WORKDIR /app

# Manifests first so `pnpm install` caches as a layer independent of source
# edits. pnpm-workspace.yaml carries allowBuilds (better-sqlite3, sharp) —
# without it pnpm skips their install scripts and they fail at require time.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
COPY packages/geometry/package.json packages/geometry/

# `...` pulls the server plus its workspace dependencies only; the web app's
# tree (Next, React, Pixi) stays out of this image. Dev deps stay in because
# the runtime is tsx (a devDependency): the server runs TS source directly,
# same as `pnpm start` locally.
RUN pnpm install --frozen-lockfile --filter @puzzlewithme/server...

COPY packages ./packages
COPY apps/server ./apps/server

# Run from the package dir: SQLITE_PATH and IMAGE_UPLOADS_DIR defaults are
# cwd-relative (see main.ts), so state lands under /app/apps/server/data where
# the compose volume mounts.
WORKDIR /app/apps/server
ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "start"]
