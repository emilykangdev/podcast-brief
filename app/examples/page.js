import { Suspense } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import config from "@/config";
import { getSEOTags } from "@/libs/seo";
import { exampleBriefs } from "@/libs/example-briefs.mjs";

export const metadata = getSEOTags({
  title: `Example briefs | ${config.appName}`,
  description:
    "See exactly what a PodcastBrief looks like — full briefs from real episodes, with ideas, insights, quotes, and references unpacked.",
  canonicalUrlRelative: "/examples",
});

export default function ExamplesPage() {
  return (
    <>
      <Suspense>
        <Header />
      </Suspense>
      <main>
        <section className="relative overflow-hidden bg-base-100">
          <div
            className="absolute inset-0 opacity-[0.12]"
            style={{
              backgroundImage:
                "radial-gradient(circle, currentColor 1px, transparent 1px)",
              backgroundSize: "24px 24px",
            }}
          />
          <svg
            className="absolute inset-0 w-full h-full opacity-[0.12]"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle cx="20%" cy="25%" r="80" stroke="currentColor" strokeWidth="1" fill="none" />
            <circle cx="80%" cy="20%" r="60" stroke="currentColor" strokeWidth="1" fill="none" />
            <circle cx="65%" cy="75%" r="100" stroke="currentColor" strokeWidth="1" fill="none" />
            <circle cx="15%" cy="80%" r="55" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
          <div className="relative max-w-3xl mx-auto px-8 py-20 lg:py-28 text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-base-content/60 mb-4">
              Example briefs
            </p>
            <h1 className="font-extrabold text-4xl lg:text-5xl tracking-tight">
              See exactly what you&apos;ll get
            </h1>
            <p className="mt-6 text-base opacity-80 leading-relaxed">
              Real briefs from real episodes. Key ideas, insights, quotes, and references — unpacked, structured, and ready to act on.
            </p>
          </div>
        </section>

        <section className="max-w-4xl mx-auto px-8 py-16 space-y-6">
          {exampleBriefs.map((brief, i) => (
            <Link
              key={brief.slug}
              href={`/examples/${brief.slug}`}
              className="group block rounded-2xl border border-base-content/10 bg-base-200/40 hover:bg-base-200 hover:border-primary/40 transition-all p-8 lg:p-10"
            >
              <div className="flex items-start justify-between gap-4 mb-3">
                <p className="text-xs uppercase tracking-[0.2em] text-primary/80">
                  Example {String(i + 1).padStart(2, "0")}
                </p>
                <div className="flex gap-3 text-xs text-base-content/50">
                  {brief.durationLabel && (
                    <>
                      <span>{brief.durationLabel}</span>
                      <span aria-hidden>·</span>
                    </>
                  )}
                  <span>{brief.readingLabel}</span>
                </div>
              </div>
              {brief.podcastName && (
                <p className="text-sm font-semibold text-base-content/60 mb-1">
                  {brief.podcastName}
                </p>
              )}
              <h2 className="text-2xl lg:text-3xl font-extrabold tracking-tight group-hover:text-primary transition-colors">
                {brief.title}
              </h2>
              <p className="text-base text-base-content/70 mt-2">{brief.subtitle}</p>
              <p className="mt-5 text-base-content/80 leading-relaxed">{brief.summary}</p>
              <span className="inline-flex items-center gap-2 mt-6 text-primary font-semibold">
                Read full brief
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
              </span>
            </Link>
          ))}
        </section>

        <section className="border-t border-base-content/10 bg-base-200/40">
          <div className="max-w-3xl mx-auto px-8 py-20 text-center">
            <h2 className="font-extrabold text-2xl lg:text-3xl tracking-tight">
              Want one for your own podcast?
            </h2>
            <p className="mt-3 text-base-content/70">
              Drop in any Apple Podcasts episode URL and you&apos;ll get a brief like this in minutes.
            </p>
            <Link href={config.auth.loginUrl} className="btn btn-primary btn-wide mt-8">
              Try It Out
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
