import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import config from "@/config";
import { getSEOTags } from "@/libs/seo";
import {
  exampleBriefs,
  getExampleBrief,
  loadExampleBriefMarkdown,
} from "@/libs/example-briefs.mjs";
import ExampleBriefArticle from "./ExampleBriefArticle";

export function generateStaticParams() {
  return exampleBriefs.map((b) => ({ slug: b.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const brief = getExampleBrief(slug);
  if (!brief) return {};
  return getSEOTags({
    title: `${brief.title} | Example brief`,
    description: brief.summary,
    canonicalUrlRelative: `/examples/${brief.slug}`,
  });
}

export default async function ExampleBriefPage({ params }) {
  const { slug } = await params;
  const brief = getExampleBrief(slug);
  if (!brief) notFound();

  const markdown = await loadExampleBriefMarkdown(slug);
  if (!markdown) notFound();

  return (
    <>
      <Suspense>
        <Header />
      </Suspense>
      <main>
        <section className="border-b border-base-content/10 bg-base-200/40">
          <div className="max-w-3xl mx-auto px-8 pt-12 pb-10">
            <Link
              href="/examples"
              className="inline-flex items-center gap-1.5 text-sm text-base-content/60 hover:text-base-content"
            >
              <ArrowLeft className="w-4 h-4" />
              All examples
            </Link>
            <p className="mt-8 text-xs uppercase tracking-[0.2em] text-primary/80">
              Example brief
            </p>
            {brief.podcastName && (
              <p className="mt-3 text-sm font-semibold text-base-content/60">
                {brief.podcastName}
              </p>
            )}
            <h1 className="mt-2 font-extrabold text-3xl lg:text-4xl tracking-tight">
              {brief.title}
            </h1>
            <p className="mt-3 text-base-content/70">{brief.subtitle}</p>
            <div className="flex gap-3 text-xs text-base-content/50 mt-5">
              {brief.durationLabel && (
                <>
                  <span>{brief.durationLabel}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>{brief.readingLabel}</span>
            </div>
          </div>
        </section>

        <section className="max-w-3xl mx-auto px-8 py-12 lg:py-16">
          <ExampleBriefArticle markdown={markdown} />
        </section>

        <section className="border-t border-base-content/10 bg-base-200/40">
          <div className="max-w-3xl mx-auto px-8 py-16 text-center">
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
