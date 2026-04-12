import configFile from "@/config";
import { findCheckoutSession } from "@/libs/stripe";
import supabase from "@/libs/supabase/admin.mjs";
import { getPostHog } from "@/libs/posthog/server";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import Stripe from "stripe";

export async function POST(req) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("Missing required Stripe environment variables");
    return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2023-08-16",
  });
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  const body = await req.text();
  const signature = (await headers()).get("stripe-signature");

  let event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error(`Webhook signature verification failed. ${err.message}`);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const stripeObject = event.data.object;
        const session = await findCheckoutSession(stripeObject.id);
        const customerId = session?.customer;
        const priceId = session?.line_items?.data[0]?.price.id;
        const userId = stripeObject.client_reference_id;
        const plan = configFile.stripe.plans.find((p) => p.priceId === priceId);

        // Guard: skip if plan not recognized or no user (e.g. replayed pre-auth event)
        if (!plan || !userId) break;

        const customer = await stripe.customers.retrieve(customerId);

        // Upsert profile (has_access kept as "has ever paid" flag)
        await supabase.from("profiles").upsert({
          id: userId,
          email: customer.email,
          customer_id: customerId,
          price_id: priceId,
          has_access: true,
        });

        // Projected balance for the ledger snapshot (audit field, not source of truth)
        const { data: profile } = await supabase
          .from("profiles")
          .select("credits")
          .eq("id", userId)
          .single();
        const projectedBalance = (profile?.credits ?? 0) + plan.credits;

        // Step 1: LEDGER INSERT FIRST — unique index on stripe_event_id is the idempotency gate.
        // If this succeeds, we know this is the first delivery of this event.
        const { error: ledgerError } = await supabase
          .from("credit_ledger")
          .insert({
            profile_id: userId,
            delta_credits: plan.credits,
            credits_left: projectedBalance,
            reason: `purchase:${plan.name}`,
            stripe_event_id: event.id,
            environment: process.env.APP_ENV || "DEVELOPMENT",
          });

        if (ledgerError) {
          if (ledgerError.code === "23505") {
            // Duplicate webhook delivery — already processed, skip
            console.log(`Duplicate webhook ${event.id}, skipping`);
            break;
          }
          throw ledgerError;
        }

        // Step 2: Ledger insert succeeded → atomically increment credits.
        // If this fails, roll back the ledger entry so Stripe's retry gets a clean slate.
        const { error: updateError } = await supabase.rpc("increment_credits", {
          p_profile_id: userId,
          p_amount: plan.credits,
        });

        if (updateError) {
          // Roll back ledger so the next retry attempt won't hit 23505 and skip
          await supabase.from("credit_ledger").delete().eq("stripe_event_id", event.id);
          console.error(`increment_credits failed for ${event.id}, ledger rolled back:`, updateError.message);
          return NextResponse.json({ error: "Credit increment failed" }, { status: 503 });
        }

        const posthog = getPostHog();
        posthog?.capture({
          distinctId: userId,
          event: "credit_purchase",
          properties: {
            plan_name: plan.name,
            price_id: priceId,
            price: plan.price,
            credits: plan.credits,
            customer_id: customerId,
          },
          uuid: event.id,
        });
        await posthog?.flush();

        break;
      }

      case "checkout.session.expired": {
        // User didn't complete payment — no action needed
        break;
      }

      default:
        // Unhandled event type
    }
  } catch (e) {
    console.error("stripe error: ", e.message);
    // Return 503 so Stripe retries on transient failures
    return NextResponse.json({ error: "Internal error" }, { status: 503 });
  }

  return NextResponse.json({});
}
