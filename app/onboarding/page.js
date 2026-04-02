// Client component — lets users submit an Apple Podcasts URL to kick off brief generation.
// Calls /api/jobs/brief (server-side proxy to Railway worker) and shows inline status.
"use client";

import { useState } from "react";
import config from "@/config";

export default function OnboardingPage() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/jobs/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeUrl: url }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Something went wrong. Please try again.");
        return;
      }

      setSubmitted(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center p-8"
      data-theme={config.colors.theme}
    >
      <div className="max-w-xl w-full space-y-10">
        <h1 className="text-3xl font-extrabold tracking-tight text-center">
          Let&apos;s get started
        </h1>

        {/* Step 1 */}
        <div className="space-y-4">
          <p className="text-lg font-semibold">Step 1: Enter an Apple Podcasts URL</p>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://podcasts.apple.com/..."
            className="input input-bordered w-full"
          />
          <button
            className="btn btn-primary btn-block"
            onClick={handleSubmit}
            disabled={loading || !url.trim()}
          >
            {loading ? "Generating..." : "Generate Brief"}
          </button>
          {error && <p className="text-error text-sm">{error}</p>}
        </div>

        {/* Step 2 */}
        <div className={submitted ? "space-y-2" : "opacity-50 space-y-2"}>
          <p className="text-lg font-semibold">Step 2: Check your inbox</p>
          <p className="text-base-content/70">
            {submitted
              ? "Your brief is being generated — we'll let you know when it's ready."
              : "Your brief will arrive in about a minute in your email inbox."}
          </p>
        </div>
      </div>
    </main>
  );
}
