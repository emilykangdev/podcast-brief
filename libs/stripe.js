import Stripe from "stripe";

// Creates a Stripe Embedded Checkout session. Returns the client_secret for the
// EmbeddedCheckoutProvider on the frontend. Webhook handles post-payment crediting.
export const createCheckout = async ({
  priceId,
  mode,
  returnUrl,
  couponId,
  clientReferenceId,
  user,
}) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const extraParams = {};

  if (user?.customerId) {
    extraParams.customer = user.customerId;
  } else {
    if (mode === "payment") {
      extraParams.customer_creation = "always";
      extraParams.payment_intent_data = { setup_future_usage: "on_session" };
    }
    if (user?.email) {
      extraParams.customer_email = user.email;
    }
    extraParams.tax_id_collection = { enabled: true };
  }

  const stripeSession = await stripe.checkout.sessions.create({
    ui_mode: "embedded",
    mode,
    client_reference_id: clientReferenceId,
    line_items: [{ price: priceId, quantity: 1 }],
    return_url: returnUrl,
    // allow_promotion_codes and discounts are mutually exclusive in the Stripe API
    ...(couponId
      ? { discounts: [{ coupon: couponId }] }
      : { allow_promotion_codes: true }),
    ...extraParams,
  });

  return stripeSession.client_secret;
};

// This is used to get the uesr checkout session and populate the data so we get the planId the user subscribed to
export const findCheckoutSession = async (sessionId) => {
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items"],
    });

    return session;
  } catch (e) {
    console.error(e);
    return null;
  }
};
