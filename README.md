# PodcastBrief


# Schema

How will I accept login?

- email
    - just login with google OAuth. See what info this needs
- make sure magic link works for logging user in
- credits left (1 credit to get 1 brief)
- stripeId

(skip email and password for now)

# Briefs

Should definitely have their own Brief ID

# Email output

Giving a Markdown brief to users must be first-class. 

Use both in the email:

Primary body: rendered HTML (best readability/deliverability)
Also include:
A “Copy Markdown” section (plain fenced block, or link/button to view raw markdown)
A text/plain MIME part containing the raw Markdown
So DB stays:

output_markdown TEXT as source of truth
Optional output_html TEXT as cache (or render on send)
This gives users copy/paste-friendly Markdown without sacrificing email rendering quality.

# Credit handling

A ledger model is better because it'll show the last change made to the credits for a user. One row per change! So one row says one delta, timestamp, etc and is connected to a profile id. 

Basically: It's a split.

`profiles.credits` (or current_credits) as the fast, current balance integer.
`credit_ledger` as immutable history rows.

The credit_ledger tabel should thus have: 

id
profile_id
delta_credits (still useful)
credits_left (historical snapshot)
reason
created_at

So none of those columns should ever be updated 


Yes, exactly.

Server-side check: controls behavior (don’t generate brief if no credits).
DB constraint: protects data integrity (never allow negative balance even if code/race/bug slips through).
So app logic enforces product rules; DB constraints enforce invariant rules.

