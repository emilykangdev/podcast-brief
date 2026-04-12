"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import JSZip from "jszip";
import apiClient from "@/libs/api";
import { Mail } from "lucide-react";
import BriefRequestForm from "@/components/BriefRequestForm";
import BriefModal from "@/components/BriefModal";
import CreditBalance from "@/components/CreditBalance";
import CreditPackModal from "@/components/CreditPackModal";

export default function DashboardClient({ briefs, credits, userEmail }) {
  const router = useRouter();
  const [selectedBrief, setSelectedBrief] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [regenCreditData, setRegenCreditData] = useState(null);

  // Float in-progress briefs (queued/generating) to top so regenerated briefs are visible.
  // Within each group, the server-side created_at DESC order is preserved.
  const sortedBriefs = [...briefs].sort((a, b) => {
    const aActive = a.status === "queued" || a.status === "generating" ? 0 : 1;
    const bActive = b.status === "queued" || b.status === "generating" ? 0 : 1;
    return aActive - bActive;
  });

  const hasInProgress = sortedBriefs.some(b => b.status === "queued" || b.status === "generating");

  // Poll every 60s while any brief is in-progress
  useEffect(() => {
    if (!hasInProgress) return;
    const id = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(id);
  }, [hasInProgress, router]);

  async function handleDownloadAll() {
    setDownloading(true);
    try {
      const zip = new JSZip();
      const completeBriefs = briefs.filter(b => b.output_markdown);

      for (const brief of completeBriefs) {
        const folder = sanitizeFilename(brief.podcast_name ?? "Unknown Podcast");
        const file = sanitizeFilename(brief.episode_title ?? `brief-${brief.id.slice(0, 8)}`) + ".md";
        zip.folder(folder).file(file, brief.output_markdown);
      }

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `PodcastBrief-${new Date().toISOString().split("T")[0]}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setDownloading(false);
    }
  }

  async function handleRegenerate(brief) {
    try {
      await apiClient.post("/jobs/brief", {
        episodeUrl: brief.input_url,
        regenerate: true,
      });
      toast.success("Regenerating brief...");
      setIsModalOpen(false);
      setSelectedBrief(null);
      router.refresh();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      if (err.creditData) {
        // Show the purchase modal instead of a toast
        setRegenCreditData(err.creditData);
        setShowCreditsModal(true);
        setIsModalOpen(false);
        setSelectedBrief(null);
      }
      // Re-throw so BriefModal's onClick catch can reset the "Regenerating..." state
      throw err;
    }
  }

  return (
    <>
      <CreditBalance credits={credits} />
      <BriefRequestForm onSuccess={() => router.refresh()} />

      <div className="flex justify-between items-center">
        <p className="text-base-content/60">
          {briefs.length} brief{briefs.length !== 1 ? "s" : ""}
        </p>
        {briefs.some(b => b.output_markdown) && (
          <button className="btn btn-sm btn-outline" onClick={handleDownloadAll} disabled={downloading}>
            {downloading ? "Zipping..." : "Download All (.zip)"}
          </button>
        )}
      </div>

      {sortedBriefs.length === 0 ? (
        <p className="text-base-content/50 text-center py-12">
          No briefs yet. Submit a podcast episode above to get started.
        </p>
      ) : (
        <div className="space-y-3">
          {sortedBriefs.map(brief => (
            <BriefCard key={brief.id} brief={brief}
                       onClick={() => { setSelectedBrief(brief); setIsModalOpen(true); }} />
          ))}
        </div>
      )}

      {selectedBrief && (
        <BriefModal
          brief={selectedBrief}
          isOpen={isModalOpen}
          onClose={() => { setIsModalOpen(false); setSelectedBrief(null); }}
          onRegenerate={handleRegenerate}
          userEmail={userEmail}
        />
      )}

      <CreditPackModal
        isOpen={showCreditsModal}
        onClose={() => setShowCreditsModal(false)}
        title="Not enough credits"
        subtitle={regenCreditData?.message || `You need ${regenCreditData?.creditsNeeded ?? "more"} credits but have ${regenCreditData?.creditsRemaining ?? 0}.`}
      />
    </>
  );
}

function BriefCard({ brief, onClick }) {
  const isInProgress = brief.status === "queued" || brief.status === "generating";
  const emailSent = brief.status === "complete" && brief.completed_at && brief.brief_email_deliveries?.some((delivery) => {
    if (delivery.status !== "sent" && delivery.status !== "delivered") return false;
    return sameTimestamp(delivery.completed_at, brief.completed_at);
  });
  return (
    <div className={`card bg-base-200 cursor-pointer hover:bg-base-300 transition-colors ${isInProgress ? "opacity-50" : ""}`}
         onClick={onClick}>
      <div className="card-body p-4 flex-row justify-between items-center">
        <div>
          <p className="font-semibold">
            {brief.episode_title ?? (isInProgress ? "Loading episode info..." : "Untitled Episode")}
          </p>
          <p className="text-sm text-base-content/60">
            {brief.podcast_name ?? ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {emailSent && (
            <div className="tooltip" data-tip="Email sent. Please check spam if you don't see it in your inbox.">
              <Mail className="w-4 h-4 text-base-content/60" />
            </div>
          )}
          <StatusBadge status={brief.status} hasContent={!!brief.output_markdown} />
          <span className="text-sm text-base-content/40">
            {new Date(brief.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, hasContent }) {
  if (status === "generating") return <span className="badge badge-sm badge-warning">Generating</span>;
  if (status === "queued") return <span className="badge badge-sm badge-info">Queued</span>;
  if (status !== "complete") return null;

  // Badge is based on whether the user has a readable brief, not internal pipeline errors.
  // error_log is for developer diagnostics (check Supabase), not user-facing status.
  if (!hasContent) return <span className="badge badge-sm badge-error">Failed</span>;
  return <span className="badge badge-sm badge-success">Complete</span>;
}

function sameTimestamp(a, b) {
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  return Number.isFinite(aTime) && Number.isFinite(bTime) && aTime === bTime;
}

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, "-").trim();
}
