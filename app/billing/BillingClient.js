"use client";

import Link from "next/link";
import { formatDuration } from "@/libs/credits";

function descriptionFor(entry) {
  const dur = entry.durationSeconds ? ` (${formatDuration(entry.durationSeconds)})` : "";
  switch (entry.type) {
    case "purchase": return `Purchased ${entry.label}`;
    case "brief": return `Brief: ${entry.episodeTitle || "Untitled"}${entry.podcastName ? ` — ${entry.podcastName}` : ""}${dur}`;
    case "regen": return `Regenerated: ${entry.episodeTitle || "Untitled"}${dur}`;
    case "signup_bonus": return "Welcome bonus";
    case "refund": return `Refund: ${entry.label || "failed brief"}`;
    default: return entry.label || "Unknown";
  }
}

export default function BillingClient({ entries, credits }) {
  function handleDownloadCsv() {
    const header = "Date,Credits,Balance,Description\n";
    const rows = entries.map((e) => {
      const date = new Date(e.date).toLocaleDateString();
      const desc = descriptionFor(e).replace(/"/g, '""');
      return `${date},${e.delta > 0 ? "+" : ""}${e.delta},${e.balance},"${desc}"`;
    }).join("\n");

    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `PodcastBrief-credits-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="space-y-6">
      {/* Balance + Buy More */}
      <div className="flex items-center justify-between">
        <p className="text-lg font-semibold">
          {credits} credit{credits === 1 ? "" : "s"} remaining
        </p>
        <Link href="/#pricing" className="btn btn-primary btn-sm">
          Buy More Credits
        </Link>
      </div>

      {/* Credit history table */}
      {entries.length === 0 ? (
        <p className="text-base-content/50 text-center py-12">No transactions yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Date</th>
                <th>Credits</th>
                <th>Balance</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="text-base-content/60 whitespace-nowrap">
                    {new Date(entry.date).toLocaleDateString()}
                  </td>
                  <td className={`font-mono ${entry.delta > 0 ? "text-success" : "text-base-content/60"}`}>
                    {entry.delta > 0 ? "+" : ""}{entry.delta}
                  </td>
                  <td className="font-mono text-base-content/60">
                    {entry.balance}
                  </td>
                  <td>{descriptionFor(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* CSV export */}
      {entries.length > 0 && (
        <div className="flex justify-end">
          <button className="btn btn-sm btn-outline" onClick={handleDownloadCsv}>
            Download CSV
          </button>
        </div>
      )}
    </div>
  );
}
