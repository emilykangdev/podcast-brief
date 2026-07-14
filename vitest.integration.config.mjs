import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Integration tests hit a real local Supabase Postgres (via the Supabase CLI) and run
// concurrency races, so they're slower and never run in watch mode by default.
// Deliberately not built via mergeConfig(vitest.config.mjs, ...) — mergeConfig concatenates
// `test.include` arrays rather than replacing them, which would silently re-run the unit
// suite here too.
export default defineConfig({
  resolve: {
    alias: {
      "@": dirname,
      "server-only": path.resolve(dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.js"],
    testTimeout: 30_000,
    // Integration tests share one local Postgres instance and create real rows —
    // run files sequentially so races are deliberate (inside a test), not incidental
    // (between tests).
    fileParallelism: false,
  },
});
