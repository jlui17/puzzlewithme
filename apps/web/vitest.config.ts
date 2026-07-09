import { defineConfig } from "vitest/config";

// Same reason as packages/*/vitest.config.ts: the root config's `projects`
// paths resolve against cwd, so running this package's own test script needs a
// local, project-only config. Scoped to src so Next's build output (.next) and
// the app/ pages are never picked up as tests. Default node environment: the
// sync core is DOM-free, so no jsdom.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
