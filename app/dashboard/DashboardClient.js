"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import JSZip from "jszip";
import apiClient from "@/libs/api";
import BriefRequestForm from "@/components/BriefRequestForm";
import BriefModal from "@/components/BriefModal";

export default function DashboardClient({ briefs }) {
  const router = useRouter();
  const [selectedBrief, setSelectedBrief] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const hasInProgress = briefs.some(b => b.status === "queued" || b.status === "generating");

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
    } catch {
      // apiClient interceptor handles toast errors
    }
  }

  return (
    <>
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

      {briefs.length === 0 ? (
        <p className="text-base-content/50 text-center py-12">
          No briefs yet. Submit a podcast episode above to get started.
        </p>
      ) : (
        <div className="space-y-3">
          {briefs.map(brief => (
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
        />
      )}
    </>
  );
}

function BriefCard({ brief, onClick }) {
  const isInProgress = brief.status === "queued" || brief.status === "generating";
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
          <StatusBadge status={brief.status} hasError={!!brief.error_log} />
          <span className="text-sm text-base-content/40">
            {new Date(brief.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, hasError }) {
  if (status === "complete" && !hasError) return <span className="badge badge-sm badge-success">Complete</span>;
  if (status === "complete" && hasError) return <span className="badge badge-sm badge-warning">Issues</span>;
  if (status === "generating") return <span className="badge badge-sm badge-warning">Generating</span>;
  if (status === "queued") return <span className="badge badge-sm badge-info">Queued</span>;
  return null;
}

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, "-").trim();
}
