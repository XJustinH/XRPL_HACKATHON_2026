import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        // UI and pure-logic tests. Server-side test files opt into Node with
        // a `// @vitest-environment node` docblock.
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
          exclude: ["**/*.int.test.ts", "node_modules/**"],
        },
      },
      {
        // Requires Postgres (`npm run db:up`) and TEST_DATABASE_URL.
        // DB test files share one database and truncate it, so they run one file at a time
        // in a single fork. Tests within a file still run in order.
        extends: true,
        test: {
          name: "db",
          environment: "node",
          include: ["src/**/*.int.test.ts", "tests/**/*.int.test.ts"],
          globalSetup: ["./src/lib/db/test-global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
