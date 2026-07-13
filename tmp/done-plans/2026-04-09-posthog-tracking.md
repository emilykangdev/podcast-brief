# PostHog Integration: Error Tracking, LLM Analytics & Product Events

## Goal

Add PostHog to the podcast-brief app across three phases:
1. **Phase 1**: SDK setup + error tracking (posthog-js client, posthog-node server)
2. **Phase 2**: LLM analytics with traces/spans for the OpenRouter pipeline
3. **Phase 3**: Product events (sign up, credit purchase, brief generation)

## Why

- No analytics or error tracking exists anywhere in the codebase today
- Pipeline errors currently only go to console.error + a webhook — not searchable, not filterable
- OpenRouter token usage and cost data is thrown away (never captured from API responses)
- No visibility into user lifecycle (sign up → purchase → brief generation)

## What

### Success Criteria

- [ ] PostHog JS provider wraps the Next.js app; client-side errors auto-captured
- [ ] PostHog Node singleton used by API routes + Railway worker; server-side errors captured
- [ ] `error.js` and new `global-error.js` send exceptions to PostHog
- [ ] Express worker uses `setupExpressErrorHandler` for uncaught route errors
- [ ] Each OpenRouter call emits `$ai_generation` with tokens, cost, latency, model
- [ ] Pipeline runs emit `$ai_span` wrapping all generations with a shared `$ai_trace_id`
- [ ] Product events: `sign_up`, `credit_purchase`, `brief_queued` captured with relevant properties
- [ ] All events include `distinctId` (user ID from Supabase auth)

## All Needed Context

### Documentation & References

```yaml
- url: https://posthog.com/docs/libraries/node
  why: posthog-node setup, captureException, setupExpressErrorHandler, shutdown/flush

- url: https://posthog.com/docs/libraries/js
  why: posthog-js init options, capture_exceptions flag, identify()

- url: https://posthog.com/docs/error-tracking
  why: Error tracking setup for both client and server

- url: https://posthog.com/docs/llm-analytics/installation/manual-capture
  why: Manual $ai_generation / $ai_span / $ai_trace event structure

- url: https://posthog.com/docs/llm-analytics/spans
  why: How trace_id / span_id / parent_id link events into traces
```

### Known Gotchas & Library Quirks

```
- posthog-node events are batched. In serverless (Next.js API routes), call
  posthog.flush() before returning the response or events may be lost.
- In the long-running Railway worker (Express), use posthog.shutdown() only
  on process exit — not after every pipeline run. Regular flush() is fine.
- Express swallows errors — autocapture alone won't catch route errors.
  Must call setupExpressErrorHandler(posthog, app) AFTER all route handlers.
- $ai_latency is in SECONDS (float), not milliseconds.
- $ai_provider should be the underlying provider ("anthropic", "google"),
  not "openrouter", for PostHog cost calculations to work.
- posthog-js identify() should be called ONCE after auth, not on every page load.
- Next.js 15.1 supports instrumentation.js for server-side error hooks.
```

### Current Codebase Tree (relevant files)

```
app/
  layout.js                          ← root layout, wraps with ClientLayout
  error.js                           ← existing error boundary (no PostHog)
  signin/page.js                     ← OTP magic link sign-in
  api/
    auth/callback/route.js           ← auth completion after OTP verify
    jobs/brief/route.js              ← proxies brief generation to Railway worker
    stripe/create-checkout/route.js  ← creates Stripe checkout session
    webhook/stripe/route.js          ← Stripe webhook handler (credit purchase)
components/
  LayoutClient.js                    ← client wrapper (Crisp, Toaster, etc.)
libs/
  supabase/client.js                 ← browser Supabase client
  supabase/server.js                 ← server Supabase client
scripts/
  generate-brief.mjs                 ← callOpenRouter() for brief generation (Claude Opus)
  enrich-references.mjs              ← OpenRouter call for reference filtering (Gemini Flash)
server.mjs                           ← Railway Express worker, runs the pipeline
config.js                            ← app config
package.json                         ← no posthog packages yet
.env.example                         ← env var template
```

### Desired Codebase Tree (new/modified)

```
app/
  layout.js                          ← MODIFIED: no changes needed (ClientLayout already wraps)
  error.js                           ← MODIFIED: add captureException
  global-error.js                    ← NEW: root-level error boundary with captureException
  api/
    auth/callback/route.js           ← MODIFIED: capture sign_up event
    jobs/brief/route.js              ← MODIFIED: capture brief_queued event
    webhook/stripe/route.js          ← MODIFIED: capture credit_purchase event
components/
  LayoutClient.js                    ← MODIFIED: add PostHogProvider, identify user
libs/
  posthog/client.js                  ← NEW: posthog-js init + export
  posthog/server.js                  ← NEW: posthog-node singleton + export
scripts/
  generate-brief.mjs                 ← MODIFIED: return usage data, emit $ai_generation
  enrich-references.mjs              ← MODIFIED: return usage data, emit $ai_generation
server.mjs                           ← MODIFIED: init posthog-node, setupExpressErrorHandler,
                                        emit $ai_span per pipeline, captureException on errors
.env.example                         ← MODIFIED: add NEXT_PUBLIC_POSTHOG_KEY, POSTHOG_HOST
package.json                         ← MODIFIED: add posthog-js, posthog-node
```

## Implementation Blueprint

---

### Phase 1: SDK Setup + Error Tracking

#### Task 1: Install packages

```bash
npm install posthog-js posthog-node
```

#### Task 2: Create `libs/posthog/client.js`

```js
// Client-side PostHog singleton — import in client components only
import posthog from "posthog-js";

let initialized = false;

export function initPostHog() {
  if (typeof window === "undefined" || initialized) return;
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    capture_exceptions: true, // auto-capture unhandled errors + rejections
    person_profiles: "identified_only",
    loaded: (ph) => {
      if (process.env.NODE_ENV === "development") ph.debug();
    },
  });
  initialized = true;
}

export { posthog };
```

#### Task 3: Create `libs/posthog/server.js`

```js
// Server-side PostHog singleton — used by API routes + Railway worker
import { PostHog } from "posthog-node";

let instance = null;

export function getPostHog() {
  if (!instance) {
    instance = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
      enableExceptionAutocapture: true,
    });
  }
  return instance;
}
```

#### Task 4: Modify `components/LayoutClient.js`

Add PostHog initialization and user identification. Insert alongside existing Crisp setup:

```js
// Add imports at top
import { initPostHog, posthog } from "@/libs/posthog/client";

// Inside ClientLayout component, add useEffect:
useEffect(() => {
  initPostHog();
}, []);

// Inside CrispChat component, after the existing user fetch (line ~26),
// add PostHog identify when user is available:
useEffect(() => {
  if (data?.user) {
    posthog.identify(data.user.id, { email: data.user.email });
  }
}, [data]);
```

IMPORTANT: Do NOT wrap children in a PostHogProvider component. The singleton pattern with `initPostHog()` is sufficient since we're using `posthog` directly, not React hooks from `posthog-js/react`.

#### Task 5: Modify `app/error.js`

Add PostHog exception capture:

```js
// Add at top:
import { posthog } from "@/libs/posthog/client";

// Add useEffect inside the component:
useEffect(() => {
  posthog.captureException(error);
}, [error]);
```

#### Task 6: Create `app/global-error.js`

New file — catches errors in the root layout itself:

```js
"use client";
import { posthog } from "@/libs/posthog/client";
import { useEffect } from "react";

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    posthog.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <h2>Something went wrong</h2>
        <button onClick={reset}>Try again</button>
      </body>
    </html>
  );
}
```

#### Task 7: Modify `server.mjs` — add PostHog error tracking to Express worker

```js
// Add import at top:
import { PostHog, setupExpressErrorHandler } from "posthog-node";

// After creating the Express app (after line 39), init PostHog:
const posthog = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
  host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
  enableExceptionAutocapture: true,
});

// AFTER all route handlers (after the app.post("/jobs/brief", ...) block),
// add Express error handler:
setupExpressErrorHandler(posthog, app);

// In runPipeline catch block (line ~211), add:
posthog.captureException(err, profileId, {
  briefId,
  jobId,
  episodeUrl,
  pipeline_step: errorLog[errorLog.length - 1]?.step ?? "unknown",
});

// On process exit, flush:
process.on("SIGTERM", async () => {
  await posthog.shutdown();
  process.exit(0);
});
```

#### Task 8: Modify `.env.example`

Add:
```
# ── PostHog ─────────────────────────────────────────────────────────────────
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

---

### Phase 2: LLM Analytics (Traces & Spans)

#### Task 9: Modify `scripts/generate-brief.mjs` — return usage data from callOpenRouter

The current `callOpenRouter` function (line 17-42) only returns `choices[0].message.content`. Modify it to return usage metadata too:

```js
// Change the return at line 41 from:
//   return data.choices[0].message.content;
// To:
return {
  content: data.choices[0].message.content,
  usage: data.usage ?? {},      // { prompt_tokens, completion_tokens, total_tokens }
  model: data.model ?? "unknown",
};
```

Then update ALL callers of `callOpenRouter` in this file:

1. `extractChunk` (line 70-78): currently returns `callOpenRouter(...)` directly.
   Change to: `const result = await callOpenRouter(...); return result;`
   Then update `chunkBriefs` handling in `run()` to extract `.content` for merging.

2. `mergeChunks` (line 80-102): currently returns `callOpenRouter(...)`.
   Same change — return full result, extract `.content` where the brief text is needed.

3. In the `run()` function, after each `callOpenRouter` completes, emit `$ai_generation`.
   Pass `posthog` instance and `traceId` into `run()` via the options object.

Pseudocode for the generation event emission in `run()`:

```js
// At top of run(), generate trace/span IDs:
const traceId = randomUUID();
const pipelineSpanId = randomUUID();

// After extractChunk returns for each chunk:
const genStart = Date.now();
const result = await extractChunk(SYSTEM, chunk, i, chunks.length, promptAddition);
posthog.capture({
  distinctId: profileId,
  event: "$ai_generation",
  properties: {
    $ai_trace_id: traceId,
    $ai_span_id: randomUUID(),
    $ai_parent_id: pipelineSpanId,
    $ai_span_name: `extract-chunk-${i + 1}`,
    $ai_model: result.model,
    $ai_provider: "anthropic",  // Claude Opus via OpenRouter
    $ai_input_tokens: result.usage.prompt_tokens,
    $ai_output_tokens: result.usage.completion_tokens,
    $ai_latency: (Date.now() - genStart) / 1000,
    $ai_base_url: "https://openrouter.ai/api/v1",
  },
});

// Similarly after mergeChunks (if multi-chunk)
```

IMPORTANT: Do NOT pass full input/output content in `$ai_input` / `$ai_output_choices` — transcripts and briefs are massive. Only send token counts and cost.

Return `traceId` from `run()` so `server.mjs` can use it for the parent span.

#### Task 10: Modify `scripts/enrich-references.mjs` — same pattern

The OpenRouter call at line 21-61 (`filterAndNormalize`) similarly discards usage data. Apply the same change:
- Return `{ content, usage, model }` from the fetch call
- Emit `$ai_generation` after the call completes
- Accept `posthog`, `traceId`, `pipelineSpanId` as params from the caller

Provider for this call is `"google"` (Gemini Flash).

#### Task 11: Modify `server.mjs` — emit pipeline-level `$ai_span`

In `runPipeline`, wrap the full pipeline with timing and emit a parent span:

```js
async function runPipeline(episodeUrl, profileId) {
  const pipelineStart = Date.now();
  // ... existing code ...

  // Pass posthog + traceId into generateBriefWithValidation and enrichReferences
  // so they can emit $ai_generation events as children of the pipeline span.

  // After pipeline completes (before the `finally` block), emit:
  posthog.capture({
    distinctId: profileId,
    event: "$ai_span",
    properties: {
      $ai_trace_id: traceId,   // same ID used by child generations
      $ai_span_id: pipelineSpanId,
      $ai_span_name: "brief-pipeline",
      $ai_latency: (Date.now() - pipelineStart) / 1000,
      $ai_is_error: errorLog.length > 0,
      $ai_input_state: { episodeUrl },
      $ai_output_state: { briefId },
    },
  });
}
```

---

### Phase 3: Product Events

#### Task 12: Modify `app/api/auth/callback/route.js` — sign_up event

After the user is confirmed (line 20), capture a server-side sign_up event.
Only fire for NEW users (those redirected to /onboarding):

```js
import { getPostHog } from "@/libs/posthog/server";

// Inside the if (user) block, when data?.length === 0 (new user):
const posthog = getPostHog();
posthog.capture({
  distinctId: user.id,
  event: "sign_up",
  properties: { email: user.email },
});
await posthog.flush();
```

#### Task 13: Modify `app/api/webhook/stripe/route.js` — credit_purchase event

After the successful upsert (line 121-132), capture:

```js
import { getPostHog } from "@/libs/posthog/server";

// After the upsert succeeds and before `break`:
const posthog = getPostHog();
posthog.capture({
  distinctId: user.id,
  event: "credit_purchase",
  properties: {
    plan_name: plan.name,
    price_id: priceId,
    price: plan.price,
    customer_id: customerId,
  },
});
await posthog.flush();
```

#### Task 14: Modify `app/api/jobs/brief/route.js` — brief_queued event

After the worker responds successfully (before returning the response):

```js
import { getPostHog } from "@/libs/posthog/server";

// After workerRes.ok check passes:
const posthog = getPostHog();
posthog.capture({
  distinctId: user.id,
  event: "brief_queued",
  properties: { episode_url: episodeUrl },
});
await posthog.flush();
```

---

## Validation Loop

```bash
# Phase 1: After SDK setup
npm run lint
npm run build
# Check: no import errors, no "window is not defined" in server components

# Phase 2: After LLM analytics
# Manually verify: run a brief generation and check PostHog LLM analytics dashboard
# for $ai_generation events with correct token counts

# Phase 3: After product events
# Manually verify: sign up flow, stripe test checkout, brief generation
# all produce events visible in PostHog activity feed
```

## Testing Checklist

### Prerequisites
- [ ] Set `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` in `.env.local`
- [ ] Set the same vars on the Railway worker service
- [ ] Deploy or run locally (`npm run dev` + `node --env-file=.env.local server.mjs`)
- [ ] Open PostHog dashboard → Activity tab to watch events arrive in real-time

### 1. Client-side SDK initialization
- [ ] Open the app in browser with DevTools Console open
- [ ] Confirm `[PostHog.js]` debug log appears (dev mode auto-enables debug)
- [ ] In PostHog → Activity, confirm a `$pageview` event appears with `environment: "development"`
- [ ] Check that no events fire if you remove `NEXT_PUBLIC_POSTHOG_KEY` from `.env.local` and reload

### 2. Error tracking — client
- [ ] Temporarily throw an error in a page component (e.g. `throw new Error("test error")`)
- [ ] Confirm the error boundary renders and PostHog shows a `$exception` event
- [ ] In PostHog → Error Tracking, confirm the exception appears with a stack trace
- [ ] Remove the test error

### 3. Error tracking — server (Railway worker)
- [ ] Trigger a pipeline failure (e.g. submit an invalid episode URL that will fail in transcribe)
- [ ] Check Railway logs for `[pipeline error]` confirming the error was logged
- [ ] In PostHog → Error Tracking, confirm a server-side `$exception` event appears with `briefId`, `jobId`, `episodeUrl` properties

### 4. User identification
- [ ] Sign in with magic link
- [ ] In PostHog → Persons, find your user by email
- [ ] Confirm the person has `distinct_id` matching your Supabase user ID
- [ ] Confirm subsequent events (pageviews, etc.) are attributed to this person

### 5. Product event — sign_up
- [ ] Sign up with a **new** email (or delete your test user from Supabase first)
- [ ] Complete the magic link flow
- [ ] In PostHog → Activity, confirm a `sign_up` event appears with your user ID and email
- [ ] Sign out and sign back in with the same email — confirm NO second `sign_up` fires

### 6. Product event — credit_purchase
- [ ] Use Stripe test mode to complete a checkout
- [ ] In PostHog → Activity, confirm a `credit_purchase` event appears with `plan_name`, `price`, `price_id`, `customer_id`
- [ ] Replay the Stripe webhook via `stripe trigger checkout.session.completed` — confirm no duplicate event (idempotent UUID)

### 7. Product event — brief_queued
- [ ] Submit a brief generation request from the dashboard
- [ ] In PostHog → Activity, confirm a `brief_queued` event appears with `episode_url`

### 8. LLM analytics — $ai_generation events
- [ ] After a brief generation completes, go to PostHog → LLM Analytics (or filter Activity for `$ai_generation`)
- [ ] Confirm at least one `$ai_generation` event per pipeline run with:
  - [ ] `$ai_model` populated (e.g. `anthropic/claude-opus-4-6`)
  - [ ] `$ai_provider` = `anthropic` or `google`
  - [ ] `$ai_input_tokens` and `$ai_output_tokens` are numbers > 0
  - [ ] `$ai_latency` is a reasonable number in seconds
- [ ] If the transcript was chunked (multi-chunk), confirm multiple `extract-chunk-*` events + a `merge-chunks` event
- [ ] Confirm an `enrich-references` generation event with `$ai_provider: "google"`

### 9. LLM analytics — $ai_span (pipeline trace)
- [ ] After a brief generation completes, filter for `$ai_span` events
- [ ] Confirm a `brief-pipeline` span appears with:
  - [ ] `$ai_trace_id` matching the child `$ai_generation` events
  - [ ] `$ai_latency` covering the full pipeline duration
  - [ ] `$ai_input_state.episodeUrl` populated
  - [ ] `$ai_output_state.briefId` populated
- [ ] In PostHog → LLM Analytics → Traces, confirm the trace view shows the pipeline span with nested generation children

### 10. Environment filtering
- [ ] In PostHog → Activity, filter events by property `environment = development`
- [ ] Confirm only dev events show up
- [ ] After deploying to prod, confirm prod events have `environment = production`

## Deprecated Code to Remove

None — this is purely additive. The existing `alertDeveloper` webhook function in `server.mjs` should be KEPT as-is (it serves a different purpose — immediate Slack/Discord alerts).

## Anti-Patterns to Avoid

- Do NOT import posthog-js in server-side code (API routes, server.mjs) — use posthog-node
- Do NOT send full transcript/brief text in `$ai_input` / `$ai_output_choices` — too large
- Do NOT call `posthog.shutdown()` in API routes — use `posthog.flush()` instead (shutdown destroys the instance)
- Do NOT wrap children in PostHogProvider — use the singleton `initPostHog()` pattern
- Do NOT fire sign_up for returning users — only when `data?.length === 0` (new user going to onboarding)

# Confidence

8/10 straightforward just logging