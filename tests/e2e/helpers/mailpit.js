const MAILPIT_URL = process.env.MAILPIT_URL || "http://127.0.0.1:54324";

// Polls Mailpit (local Supabase's dev SMTP capture) for the most recent message to `email`,
// then extracts the Supabase auth verification link from its body. Supabase's local Auth
// server sends real magic-link emails here instead of a live Resend send.
export async function waitForMagicLink(email, { timeoutMs = 10_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const searchRes = await fetch(
        `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`
      );
      const { messages } = await searchRes.json();
      if (messages?.length) {
        const messageRes = await fetch(`${MAILPIT_URL}/api/v1/message/${messages[0].ID}`);
        const message = await messageRes.json();
        const link = extractVerifyLink(message.Text || message.HTML);
        if (link) return link;
        lastError = new Error("Found email but no verification link inside it");
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `No magic link email arrived for ${email} within ${timeoutMs}ms. ${lastError ? `Last error: ${lastError.message}` : ""}`
  );
}

function extractVerifyLink(body) {
  if (!body) return null;
  const match = body.match(/https?:\/\/[^\s"<>]+\/auth\/v1\/verify\?[^\s"<>]+/);
  return match ? match[0].replace(/&amp;/g, "&") : null;
}
