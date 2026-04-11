"use client";

import { Suspense, useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import Link from "next/link";
import apiClient from "@/libs/api";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);

function CheckoutForm() {
  const searchParams = useSearchParams();
  const priceId = searchParams.get("priceId");
  const mode = searchParams.get("mode") || "payment";
  const [fetchError, setFetchError] = useState(null);

  const fetchClientSecret = useCallback(async () => {
    try {
      const data = await apiClient.post("/stripe/create-checkout", { priceId, mode });
      return data.clientSecret;
    } catch (e) {
      setFetchError(e.message || "Could not start checkout. Please try again.");
      throw e;
    }
  }, [priceId, mode]);

  if (!priceId) {
    return (
      <main className="min-h-screen flex items-center justify-center p-8">
        <p>Invalid checkout link.</p>
      </main>
    );
  }

  if (fetchError) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center p-8 gap-4">
        <p className="text-error">{fetchError}</p>
        <Link href="/#pricing" className="btn btn-primary">Back to Pricing</Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8">
      <EmbeddedCheckoutProvider stripe={stripePromise} options={{ fetchClientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </main>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<main className="min-h-screen flex items-center justify-center p-8"><span className="loading loading-spinner" /></main>}>
      <CheckoutForm />
    </Suspense>
  );
}
