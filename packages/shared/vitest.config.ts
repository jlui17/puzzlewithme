import { defineConfig } from "vitest/config";

// Root's vitest.config.ts defines its workspace `projects` as paths relative
// to itself (e.g. "apps/server"); vitest resolves those relative to the
// current working directory, not the config file's location. Running this
// package's own `test` script (`pnpm --filter @puzzlewithme/shared test`)
// sets cwd to this directory, so without a local config vitest picks up the
// root one and fails resolving "apps/server" against packages/shared/apps/server.
// A local, project-only config sidesteps that instead of touching root config.
export default defineConfig({
  test: {
    // Explicit (rather than vitest's default exclude-dist behavior) because
    // this config's presence is itself what stops the root config's broken
    // "projects" resolution (see comment above) — if a future edit here
    // drops the defaults, dist's compiled *.test.js would silently get
    // picked up and double-run every test whenever a build artifact exists.
    include: ["src/**/*.test.ts"],
  },
});
