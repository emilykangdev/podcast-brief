// Client component — lets users submit an Apple Podcasts URL to kick off brief generation.
// Calls /api/jobs/brief (server-side proxy to Railway worker) and shows inline status.
"use client";

import { useState } from "react";

export default function BriefRequestForm() {
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

  if (submitted) {
    return (
      <p className="text-base-content/70">
        Your brief is being generated — we&apos;ll let you know when it&apos;s
        ready.
      </p>
    );
  }

  return (
    <div className="space-y-4">
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
  );
}
