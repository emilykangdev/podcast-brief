"use client";

import { useRouter } from "next/navigation";
import config from "@/config";

// Sorted plans: largest first (primary CTA), then descending.
const sortedPlans = [...config.stripe.plans]
  .sort((a, b) => b.credits - a.credits);

export default function CreditPackModal({ isOpen, onClose, title, subtitle }) {
  const router = useRouter();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-base-100 rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
        <h3 className="font-bold text-lg">{title}</h3>
        {subtitle && <p className="text-sm text-base-content/70">{subtitle}</p>}
        <div className="space-y-2">
          {sortedPlans.map((plan, i) => (
            <button
              key={plan.priceId}
              className={i === 0 ? "btn btn-primary btn-block" : i === 1 ? "btn btn-outline btn-block" : "btn btn-ghost btn-sm btn-block"}
              onClick={() => router.push(`/checkout?priceId=${plan.priceId}&mode=payment`)}
            >
              {plan.credits} credits &mdash; ${plan.price}
            </button>
          ))}
        </div>
        <button className="btn btn-ghost btn-sm btn-block" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
