import { test, expect } from "@playwright/test";
import { randomUUID } from "crypto";
import { waitForMagicLink } from "./helpers/mailpit.js";

// Signup -> magic link -> onboarding -> dashboard. Per README ("Authentication Flow"), the
// #1 login-failure mode is opening the magic link in a different browser/context (the PKCE
// code_verifier cookie set at signInWithOtp time is missing) — this test uses one browser
// context throughout, so it covers the happy path, not that failure mode.
test("new user signs up, follows the magic link, and lands on onboarding", async ({ page }) => {
  const email = `e2e-${randomUUID()}@example.com`;

  await page.goto("/signin");
  await page.getByPlaceholder("tom@cruise.com").fill(email);
  await page.getByRole("button", { name: /continue with email/i }).click();
  await expect(page.getByText(/check your emails/i)).toBeVisible();

  const magicLink = await waitForMagicLink(email);
  await page.goto(magicLink);

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: /let's get started/i })).toBeVisible();

  // Session cookie persisted — /dashboard should render, not bounce back to /signin.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
});
