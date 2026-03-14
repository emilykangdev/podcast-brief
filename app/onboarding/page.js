"use client";

import { useState } from "react";
import config from "@/config";

export default function OnboardingPage() {
  const [url, setUrl] = useState("");

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
          <p className="text-lg font-semibold">
            Step 1: Enter an Apple Podcasts URL
          </p>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://podcasts.apple.com/..."
            className="input input-bordered w-full"
          />
          <button className="btn btn-primary btn-block" disabled>
            Generate Brief
          </button>
        </div>

        {/* Step 2 */}
        <div className="opacity-50 space-y-2">
          <p className="text-lg font-semibold">Step 2: Check your inbox</p>
          <p className="text-base-content/70">
            Your brief will arrive in about a minute in your email inbox.
          </p>
        </div>
      </div>
    </main>
  );
}
