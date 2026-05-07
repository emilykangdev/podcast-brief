"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function ExampleBriefArticle({ markdown }) {
  return (
    <article className="prose prose-base lg:prose-lg max-w-none prose-headings:tracking-tight prose-h1:hidden prose-h2:text-sm prose-h2:uppercase prose-h2:tracking-[0.2em] prose-h2:text-base-content/60 prose-h2:font-semibold prose-h2:mt-12 prose-h2:mb-4 prose-blockquote:border-l-primary prose-blockquote:text-base-content/70 prose-a:text-primary prose-a:no-underline hover:prose-a:underline">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </article>
  );
}
