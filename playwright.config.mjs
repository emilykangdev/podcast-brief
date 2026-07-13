import { defineConfig, devices } from "@playwright/test";

// Boots the real Next.js app against local Supabase (`supabase start`) so tests exercise
// the actual signup/auth flow rather than a mocked one. Requires .env.local to hold the
// values from .env.test.example — `next dev` always forces NODE_ENV=development
// internally (ignoring whatever NODE_ENV the parent process sets), so it only ever loads
// `.env.local`/`.env.development(.local)`, never `.env.test.local`.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
