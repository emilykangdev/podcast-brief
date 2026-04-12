import { PostHog } from "posthog-node";

let instance = null;

// Returns null if NEXT_PUBLIC_POSTHOG_KEY is not set (e.g. dev/staging).
// Callers should guard: `const posthog = getPostHog(); posthog?.capture(...)`.
export function getPostHog() {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return null;
  if (!instance) {
    instance = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    });
  }
  return instance;
}
