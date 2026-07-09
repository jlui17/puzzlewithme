import { defineConfig } from "vitest/config";

// Same reason as packages/shared/vitest.config.ts: the root config's
// `projects` paths resolve against cwd, so running this package's own test
// script needs a local, project-only config; scoping include to src keeps
// dist's compiled *.test.js from double-running when a build artifact exists.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
