// Client-side PostHog singleton. Initializes once at module load in the browser.
// posthog.__loaded is set by posthog-js after init() — prevents double-init on HMR.
import posthog from "posthog-js";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const isPostHogEnabled = Boolean(POSTHOG_KEY);

if (typeof window !== "undefined" && isPostHogEnabled && !posthog.__loaded) {
  posthog.init(POSTHOG_KEY, {
    api_host: "/ingest",
    ui_host: "https://us.i.posthog.com",
    capture_exceptions: true,
    person_profiles: "identified_only",
    loaded: (ph) => {
      if (process.env.NODE_ENV === "development") ph.debug();
      ph.register({ environment: process.env.NODE_ENV || "development" });
    },
  });
}

export { isPostHogEnabled, posthog };
