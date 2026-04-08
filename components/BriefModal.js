"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Modal from "@/components/Modal";

export default function BriefModal({ brief, isOpen, onClose, onRegenerate }) {
  const [copied, setCopied] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(brief.output_markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Modal isModalOpen={isOpen} onClose={onClose} title={brief.episode_title || "Brief"}>
      <p className="text-sm text-base-content/60">
        {brief.podcast_name} · {new Date(brief.created_at).toLocaleDateString()}
      </p>

      {brief.status === "generating" && <div className="badge badge-warning mt-2">Generating...</div>}
      {brief.status === "queued" && <div className="badge badge-info mt-2">Queued</div>}
      {brief.status === "complete" && !brief.output_markdown && (
        <div className="badge badge-error mt-2">Failed</div>
      )}

      {brief.output_markdown ? (
        <article className="prose prose-sm max-w-none mt-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {brief.output_markdown}
          </ReactMarkdown>
        </article>
      ) : (
        <p className="text-base-content/50 mt-4">
          {brief.status === "complete" ? "Brief generation failed." : "Brief is being generated..."}
        </p>
      )}

      <div className="flex gap-2 mt-6 pt-4 border-t border-base-200">
        {brief.output_markdown && (
          <button className="btn btn-sm btn-outline" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy Markdown"}
          </button>
        )}
        {brief.status === "complete" && brief.regeneration_count === 0 && (
          <button className="btn btn-sm btn-warning" onClick={() => setShowConfirm(true)}>
            Regenerate
          </button>
        )}
      </div>

      {showConfirm && (
        <div className="mt-4 p-4 bg-warning/10 rounded-lg">
          <p className="text-sm">
            This will replace the current brief. Each brief can only be regenerated once. Continue?
          </p>
          <div className="flex gap-2 mt-3">
            <button
              className="btn btn-sm btn-warning"
              disabled={regenerating}
              onClick={() => { setRegenerating(true); onRegenerate(brief); }}
            >
              {regenerating ? "Regenerating..." : "Yes, regenerate"}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setShowConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
