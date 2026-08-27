import { test, expect } from "@playwright/test";

// UI-contract tests for signin error handling. GoTrue responses are stubbed at the network
// layer (page.route) so these are deterministic and independent of Supabase being up. The
// input→status contract itself is verified against the REAL services by
// scripts/auth-contract-check.mjs (run manually — it sends a real email); these tests pin
// OUR side of the contract: response → visible UI behavior. The 500 body below is the
// literal response observed from production GoTrue during the Aug 2026 Resend-key outage,
// which the old page swallowed behind a success toast.

const OTP_ROUTE = "**/auth/v1/otp**";

async function submitEmail(page, email = "someone@example.com") {
  await page.goto("/signin");
  await page.getByPlaceholder("tom@cruise.com").fill(email);
  await page.getByRole("button", { name: /continue with email/i }).click();
}

test("SMTP failure (500) shows an error toast and allows retry", async ({ page }) => {
  await page.route(OTP_ROUTE, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        code: 500,
        error_code: "unexpected_failure",
        msg: "Error sending magic link email",
      }),
    })
  );

  await submitEmail(page);

  await expect(page.getByText(/couldn't send the sign-in link/i)).toBeVisible();
  await expect(page.getByText(/check your emails/i)).not.toBeVisible();
  // Form stays usable for retry — only a successful send disables it.
  await expect(page.getByRole("button", { name: /continue with email/i })).toBeEnabled();
});

test("rate limit (429) shows a wait-and-retry message", async ({ page }) => {
  await page.route(OTP_ROUTE, (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        code: 429,
        error_code: "over_email_send_rate_limit",
        msg: "For security purposes, you can only request this once every 60 seconds",
      }),
    })
  );

  await submitEmail(page);

  await expect(page.getByText(/too many attempts/i)).toBeVisible();
  await expect(page.getByText(/check your emails/i)).not.toBeVisible();
});

test("network failure surfaces an error, not success", async ({ page }) => {
  // supabase-js catches fetch rejections and RETURNS AuthRetryableFetchError via { error }
  // rather than throwing — exactly the path the old catch-based code missed.
  await page.route(OTP_ROUTE, (route) => route.abort("connectionrefused"));

  await submitEmail(page);

  await expect(page.getByText(/couldn't send the sign-in link/i)).toBeVisible();
  await expect(page.getByText(/check your emails/i)).not.toBeVisible();
  await expect(page.getByRole("button", { name: /continue with email/i })).toBeEnabled();
});

test("successful send shows confirmation and disables resend", async ({ page }) => {
  // Stubbed success: pins the response→UI branch. The REAL end-to-end success path
  // (actual GoTrue, actual email via Mailpit) lives in signup-onboarding.spec.js.
  await page.route(OTP_ROUTE, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) })
  );

  await submitEmail(page);

  await expect(page.getByText(/check your emails/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /continue with email/i })).toBeDisabled();
});
