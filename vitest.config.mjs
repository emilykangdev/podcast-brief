import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirrors Next.js's own webpack resolution: "server-only" throws when resolved to its
// default export (client bundle), and resolves to an empty module under the "react-server"
// condition (server bundle). Vitest has no such condition, so alias it to empty.js directly —
// these are server-side tests, never client bundles.
export default defineConfig({
  resolve: {
    alias: {
      "@": dirname,
      "server-only": path.resolve(dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.js"],
  },
});
