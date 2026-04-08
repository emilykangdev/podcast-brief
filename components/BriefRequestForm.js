// Client component — lets users submit an Apple Podcasts URL to kick off brief generation.
// Calls /api/jobs/brief to queue a brief in Supabase and shows inline status.
"use client";

import { useState } from "react";
import apiClient from "@/libs/api";

export default function BriefRequestForm({ onSuccess }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit() {
    setLoading(true);

    try {
      await apiClient.post("/jobs/brief", { episodeUrl: url });
      if (onSuccess) {
        setUrl("");
        onSuccess();
      } else {
        setSubmitted(true);
      }
    } catch {
      // apiClient interceptor already shows toast + handles 401 redirect
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
    <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="space-y-4">
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://podcasts.apple.com/..."
        className="input input-bordered w-full"
      />
      <button
        type="submit"
        className="btn btn-primary btn-block"
        disabled={loading || !url.trim()}
      >
        {loading ? "Generating..." : "Generate Brief"}
      </button>
    </form>
  );
}
