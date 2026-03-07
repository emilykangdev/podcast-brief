const config = {
  // REQUIRED
  appName: "PodcastBrief",
  // REQUIRED: a short description of your app for SEO tags (can be overwritten)
  appDescription:
    "PodcastBrief turns podcast episodes into clear learning briefs with key ideas, books, and references explained so you can actually learn from what you listen to.",
  // REQUIRED (no https://, not trialing slash at the end, just the naked domain)
  domainName: "not-yet",
  crisp: {
    // Crisp website ID. IF YOU DON'T USE CRISP: just remove this => Then add a support email in this config file (resend.supportEmail) otherwise customer support won't work.
    id: "",
    // Hide Crisp by default, except on route "/". Crisp is toggled with <ButtonSupport/>. If you want to show Crisp on every routes, just remove this below
    onlyShowOnRoutes: ["/"],
  },
  stripe: {
    // Create multiple plans in your Stripe dashboard, then add them here. You can add as many plans as you want, just make sure to add the priceId
    plans: [
      {
        // REQUIRED — we use this to find the plan in the webhook (for instance if you want to update the user's credits based on the plan)
        priceId:
          process.env.NODE_ENV === "development"
            ? "price_1T8RAZGYah0xPaVcgjGKMXSE"
            : "price_456",
        //  REQUIRED - Name of the plan, displayed on the pricing page
        name: "3 Briefs",
        // A friendly description of the plan, displayed on the pricing page. Tip: explain why this plan and not others
        description: "Perfect for trying it out",
        // The price you want to display, the one user will be charged on Stripe.
        price: 5,
        // If you have an anchor price (i.e. $29) that you want to display crossed out, put it here. Otherwise, leave it empty
        priceAnchor: '',
        features: [
          {
            name: "3 Briefs",
          },
          { name: "Sent to your email inbox" },
        ],
      },
      {
        // This plan will look different on the pricing page, it will be highlighted. You can only have one plan with isFeatured: true
        isFeatured: true,
        priceId:
          process.env.NODE_ENV === "development"
            ? "price_1T8RArGYah0xPaVcTXSHB6QP"
            : "price_456",
        name: "10 Briefs",
        description: "You want more learning power",
        price: 25,
        priceAnchor: '',
        features: [
          {
            name: "10 Briefs",
          },
          { name: "Sent to your email inbox" },
        ],
      },
    ],
  },
  aws: {
    // If you use AWS S3/Cloudfront, put values in here
    bucket: "bucket-name",
    bucketUrl: `https://bucket-name.s3.amazonaws.com/`,
    cdn: "https://cdn-id.cloudfront.net/",
  },
  resend: {
    // REQUIRED — Email 'From' field to be used when sending magic login links -- NOT USING FOR MVP March 6th
    fromNoReply: `PodcastBrief <podcastbrief.support@gmail.com>`,
    // REQUIRED — Email 'From' field to be used when sending other emails, like abandoned carts, updates etc..
    fromAdmin: `Emily at PodcastBrief <podcastbrief.support@gmail.com>`,
    // Email shown to customer if need support. Leave empty if not needed => if empty, set up Crisp above, otherwise you won't be able to offer customer support."
    supportEmail: "podcastbrief.support@gmail.com",
  },
  colors: {
    // REQUIRED — The DaisyUI theme to use (added to the main layout.js). Leave blank for default (light & dark mode).
    theme: "light",
    // REQUIRED — This color will be reflected on the whole app outside of the document (loading bar, Chrome tabs, etc..).
    // For DaisyUI v5, we use a standard primary color
    main: "#570df8",
  },
  auth: {
    // REQUIRED — the path to log in users. It's use to protect private routes (like /dashboard). It's used in apiClient (/libs/api.js) upon 401 errors from our API
    loginUrl: "/signin",
    // REQUIRED — the path you want to redirect users after successfull login (i.e. /dashboard, /private). This is normally a private page for users to manage their accounts. It's used in apiClient (/libs/api.js) upon 401 errors from our API & in ButtonSignin.js
    callbackUrl: "/dashboard",
  },
};

export default config;
