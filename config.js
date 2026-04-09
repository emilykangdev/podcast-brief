// APP_ENV, not NODE_ENV — staging runs NODE_ENV=production on Vercel,
// so using NODE_ENV would send staging users to LIVE Stripe priceIds.
const isProduction = process.env.APP_ENV === "PRODUCTION";

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
    plans: [
      {
        // TODO: replace with real Stripe priceId after creating in dashboard (test mode)
        priceId: isProduction ? "price_PROD_5_CREDITS" : "prod_U6eTyIsHGeYjiZ",
        name: "5 Credits",
        credits: 5,
        description: "Try it out",
        price: 6,
        priceAnchor: "",
        features: [
          { name: "5 credits (~5 podcast hours)" },
          { name: "$1.20 per podcast hour" },
        ],
      },
      {
        // TODO: replace with real Stripe priceId after creating in dashboard (test mode)
        priceId: isProduction ? "price_PROD_15_CREDITS" : "prod_U6eT9lYVW02Fhe",
        name: "15 Credits",
        credits: 15,
        description: "The middle ground",
        price: 15,
        priceAnchor: "",
        features: [
          { name: "15 credits (~15 podcast hours)" },
          { name: "$1.00 per podcast hour" },
        ],
      },
      {
        isFeatured: true,
        // TODO: replace with real Stripe priceId after creating in dashboard (test mode)
        priceId: isProduction ? "price_PROD_50_CREDITS" : "prod_UIowTOBsdIuY7r",
        name: "50 Credits",
        credits: 50,
        description: "What serious learners pick",
        price: 40,
        priceAnchor: "",
        features: [
          { name: "50 credits (~50 podcast hours)" },
          { name: "$0.80 per podcast hour" },
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
