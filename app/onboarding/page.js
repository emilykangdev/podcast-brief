// Onboarding page — first-time users submit an Apple Podcasts URL to generate their first brief.
"use client";

import config from "@/config";
import BriefRequestForm from "@/components/BriefRequestForm";

export default function OnboardingPage() {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center p-8"
      data-theme={config.colors.theme}
    >
      <div className="max-w-xl w-full space-y-10">
        <h1 className="text-3xl font-extrabold tracking-tight text-center">
          Let&apos;s get started
        </h1>

        <div className="space-y-4">
          <p className="text-lg font-semibold">Enter an Apple Podcasts URL</p>
          <BriefRequestForm />
        </div>
      </div>
    </main>
  );
}
