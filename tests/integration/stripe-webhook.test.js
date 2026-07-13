import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Stripe from "stripe";
import { randomUUID } from "crypto";
import supabase from "@/libs/supabase/admin.mjs";
import { createTestProfile, deleteTestProfile, getProfile } from "./helpers/factories.js";

// Real signature verification (stripe.webhooks.constructEvent, using the SDK's own
// generateTestHeaderString), real local Postgres for the insert-first idempotency ledger —
// only the two genuinely-external Stripe API calls are mocked (customers.retrieve,
// findCheckoutSession). Per Stripe's own automated-testing guidance
// (docs.stripe.com/automated-testing), this is the recommended CI pattern: generate real
// signed test events locally rather than depending on the Stripe CLI / live network in CI.

const sigRef = vi.hoisted(() => ({ value: "" }));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name) => (name === "stripe-signature" ? sigRef.value : null),
  }),
}));

vi.mock("@/libs/stripe", () => ({
  findCheckoutSession: vi.fn(),
}));

vi.mock("stripe", async (importOriginal) => {
  const actual = await importOriginal();
  const RealStripe = actual.default;
  class FakeStripe extends RealStripe {
    constructor(...args) {
      super(...args);
      // The only genuinely-external call left in route.js after mocking findCheckoutSession.
      this.customers = { retrieve: vi.fn().mockResolvedValue({ email: "webhook-test@example.com" }) };
    }
  }
  return { ...actual, default: FakeStripe };
});

const { findCheckoutSession } = await import("@/libs/stripe");
const { POST } = await import("@/app/api/webhook/stripe/route.js");

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_ID = process.env.NEXT_PUBLIC_STRIPE_PRICE_5_CREDITS; // 5-credit plan

function buildSignedRequest(event) {
  const rawBody = JSON.stringify(event);
  const signingStripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  sigRef.value = signingStripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret: WEBHOOK_SECRET,
  });
  return { text: async () => rawBody };
}

function checkoutCompletedEvent({ eventId, profileId, sessionId }) {
  return {
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        client_reference_id: profileId,
      },
    },
  };
}

const createdProfiles = [];
afterEach(async () => {
  await Promise.all(createdProfiles.splice(0).map(deleteTestProfile));
  vi.restoreAllMocks();
});

beforeEach(() => {
  findCheckoutSession.mockResolvedValue({
    customer: `cus_test_${randomUUID()}`,
    line_items: { data: [{ price: { id: PRICE_ID } }] },
  });
});

describe("Stripe webhook: checkout.session.completed idempotent crediting", () => {
  it("credits the profile exactly once on first delivery", async () => {
    const profileId = await createTestProfile({ credits: 0 });
    createdProfiles.push(profileId);
    const event = checkoutCompletedEvent({
      eventId: `evt_test_${randomUUID()}`,
      profileId,
      sessionId: `cs_test_${randomUUID()}`,
    });

    const res = await POST(buildSignedRequest(event));

    expect(res.status).toBe(200);
    const profile = await getProfile(profileId);
    expect(profile.credits).toBe(5);

    const { data: ledgerRows } = await supabase
      .from("credit_ledger")
      .select("delta_credits")
      .eq("stripe_event_id", event.id);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].delta_credits).toBe(5);
  });

  it("duplicate delivery of the same event.id does not double-credit", async () => {
    const profileId = await createTestProfile({ credits: 0 });
    createdProfiles.push(profileId);
    const event = checkoutCompletedEvent({
      eventId: `evt_test_${randomUUID()}`,
      profileId,
      sessionId: `cs_test_${randomUUID()}`,
    });

    const first = await POST(buildSignedRequest(event));
    const second = await POST(buildSignedRequest(event)); // same event.id, Stripe-style retry

    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // webhook must not error on a duplicate — Stripe would keep retrying

    const profile = await getProfile(profileId);
    expect(profile.credits).toBe(5); // not 10

    const { data: ledgerRows } = await supabase
      .from("credit_ledger")
      .select("id")
      .eq("stripe_event_id", event.id);
    expect(ledgerRows).toHaveLength(1);
  });

  it("rolls back the ledger insert when increment_credits fails, and a retry then succeeds cleanly", async () => {
    const profileId = await createTestProfile({ credits: 0 });
    createdProfiles.push(profileId);
    const event = checkoutCompletedEvent({
      eventId: `evt_test_${randomUUID()}`,
      profileId,
      sessionId: `cs_test_${randomUUID()}`,
    });

    // Force the increment_credits RPC to fail exactly once — everything else (ledger insert,
    // the rollback delete) runs against the real local Postgres.
    const rpcSpy = vi.spyOn(supabase, "rpc").mockImplementationOnce(async () => ({
      data: null,
      error: { message: "simulated increment_credits failure", code: "SIMULATED" },
    }));

    const failedRes = await POST(buildSignedRequest(event));

    expect(failedRes.status).toBe(503);
    rpcSpy.mockRestore();

    // Ledger row must be rolled back — otherwise the retry below would 23505-skip forever
    // and the user would never get credited.
    const { data: ledgerAfterFailure } = await supabase
      .from("credit_ledger")
      .select("id")
      .eq("stripe_event_id", event.id);
    expect(ledgerAfterFailure).toHaveLength(0);

    const profileAfterFailure = await getProfile(profileId);
    expect(profileAfterFailure.credits).toBe(0);

    // Stripe retries on a non-2xx response — simulate that retry with increment_credits
    // now working normally.
    const retryRes = await POST(buildSignedRequest(event));
    expect(retryRes.status).toBe(200);

    const profile = await getProfile(profileId);
    expect(profile.credits).toBe(5);
    const { data: ledgerAfterRetry } = await supabase
      .from("credit_ledger")
      .select("id")
      .eq("stripe_event_id", event.id);
    expect(ledgerAfterRetry).toHaveLength(1);
  });

  it("rejects a payload with an invalid signature", async () => {
    const event = checkoutCompletedEvent({
      eventId: `evt_test_${randomUUID()}`,
      profileId: randomUUID(),
      sessionId: `cs_test_${randomUUID()}`,
    });
    const rawBody = JSON.stringify(event);
    sigRef.value = "t=1,v1=deadbeef"; // well-formed shape, wrong HMAC

    const res = await POST({ text: async () => rawBody });

    expect(res.status).toBe(400);
  });
});
