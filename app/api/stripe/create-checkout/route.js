import configFile from "@/config";
import { createCheckout } from "@/libs/stripe";
import { createClient } from "@/libs/supabase/server";
import { NextResponse } from "next/server";

export async function POST(req) {
  const body = await req.json();
  const { priceId, mode } = body;

  if (!priceId) return NextResponse.json({ error: "Price ID is required" }, { status: 400 });
  if (!mode) return NextResponse.json({ error: "Mode is required" }, { status: 400 });
  if (mode !== "payment") {
    return NextResponse.json({ error: "Only one-time payment mode is supported" }, { status: 400 });
  }

  const plan = configFile.stripe.plans.find((p) => p.priceId === priceId);
  if (!plan) return NextResponse.json({ error: "Invalid price ID" }, { status: 400 });

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();

    const origin = new URL(req.url).origin;
    const returnUrl = `${origin}/checkout/return?session_id={CHECKOUT_SESSION_ID}`;

    const clientSecret = await createCheckout({
      priceId,
      mode,
      returnUrl,
      clientReferenceId: user.id,
      user: { email: profile?.email, customerId: profile?.customer_id },
    });

    return NextResponse.json({ clientSecret });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 });
  }
}
