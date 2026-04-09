import Link from "next/link";
import { findCheckoutSession } from "@/libs/stripe";
import { createClient } from "@/libs/supabase/server";
import config from "@/config";

export default async function CheckoutReturn({ searchParams }) {
  const params = await searchParams;
  const sessionId = params.session_id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const session = sessionId ? await findCheckoutSession(sessionId) : null;
  const isOwner = session?.client_reference_id === user?.id;
  const showError = !session || !isOwner;
  const succeeded = isOwner && session?.status === "complete";

  let creditsPurchased = 0;
  if (succeeded) {
    const priceId = session?.line_items?.data?.[0]?.price?.id;
    const plan = config.stripe.plans.find((p) => p.priceId === priceId);
    creditsPurchased = plan?.credits ?? 0;
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 gap-4">
      {showError ? (
        <>
          <h1 className="text-2xl font-bold">Something went wrong</h1>
          <p>We could not find your payment session.</p>
        </>
      ) : succeeded ? (
        <>
          <h1 className="text-2xl font-bold">Payment successful!</h1>
          <p>You now have {creditsPurchased} more credit{creditsPurchased === 1 ? "" : "s"}.</p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-bold">Payment not completed</h1>
          <p>Your payment was not completed. Please try again.</p>
        </>
      )}
      <Link href="/dashboard" className="btn btn-primary mt-4">Go to Dashboard</Link>
    </main>
  );
}
