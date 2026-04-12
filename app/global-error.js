"use client";

import { useEffect } from "react";
import { isPostHogEnabled, posthog } from "@/libs/posthog/client";

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    if (isPostHogEnabled) {
      posthog.captureException(error);
    }
  }, [error]);

  return (
    <html>
      <body>
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <h2>Something went wrong</h2>
          <button onClick={reset}>Try again</button>
        </div>
      </body>
    </html>
  );
}
