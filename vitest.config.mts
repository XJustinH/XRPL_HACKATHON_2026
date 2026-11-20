import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts", "node_modules/**"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          // Requires Postgres (docker compose up -d) and TEST_DATABASE_URL. Resets that DB.
          name: "db",
          include: ["src/**/*.int.test.ts"],
          environment: "node",
          globalSetup: ["./src/lib/db/test-global-setup.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
