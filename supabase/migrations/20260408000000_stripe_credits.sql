-- Stripe Credits — data layer for length-based credit system.
-- Session 1 of 3. No behavior changes — just schema + functions.

-- 1. credit_ledger idempotency
-- Append-only table; one row per transaction. Stripe may deliver the same webhook
-- multiple times (retries, network glitches). The unique index means the second INSERT
-- fails with 23505, so the webhook (Session 2) knows to skip the duplicate.
-- Partial index: only purchase rows carry stripe_event_id; signup/brief rows are unconstrained.
ALTER TABLE public.credit_ledger ADD COLUMN IF NOT EXISTS stripe_event_id text;
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_event_id_uniq
  ON public.credit_ledger (stripe_event_id) WHERE stripe_event_id IS NOT NULL;

-- 2. briefs credit-tracking columns
ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS episode_duration_seconds integer;
ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS credits_charged integer;

-- 2b. Replace the old cross-environment dedup index with an environment-scoped one.
-- The old index (input_url, profile_id WHERE status IN ('queued','generating')) does NOT
-- include environment, so a brief queued in STAGING could block PRODUCTION on the shared DB.
-- The new index adds environment to the uniqueness constraint.
DROP INDEX IF EXISTS idx_briefs_dedup_in_progress;
CREATE UNIQUE INDEX IF NOT EXISTS idx_briefs_dedup_in_progress
  ON public.briefs (input_url, profile_id, environment)
  WHERE status IN ('queued', 'generating');

-- 3. Atomic credit consumption + brief queueing
-- SECURITY: Locked to service_role only (revoke at bottom of file). Called from Next.js
-- API routes via the server-side Supabase client, never directly by the browser.
CREATE OR REPLACE FUNCTION public.consume_credits_and_queue_brief(
  p_profile_id uuid,
  p_episode_url text,
  p_duration_seconds integer,
  p_credits_to_charge integer,
  p_environment text DEFAULT 'DEVELOPMENT'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_credits integer;
  v_new_credits integer;
  v_brief_id uuid;
  v_existing_id uuid;
BEGIN
  -- Dedup check BEFORE credit deduction (so credits aren't lost on duplicates).
  -- Soft check; the partial unique index on briefs (queued/generating) is the hard race guard.
  SELECT id INTO v_existing_id
    FROM public.briefs
    WHERE input_url = p_episode_url
      AND profile_id = p_profile_id
      AND environment = p_environment
    LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_exists');
  END IF;

  -- Row-level lock to serialise concurrent deductions on the same profile.
  SELECT credits INTO v_current_credits
    FROM public.profiles
    WHERE id = p_profile_id
    FOR UPDATE;

  IF v_current_credits IS NULL THEN
    RETURN jsonb_build_object('error', 'profile_not_found');
  END IF;

  IF v_current_credits < p_credits_to_charge THEN
    RETURN jsonb_build_object(
      'error', 'insufficient_credits',
      'credits_remaining', v_current_credits
    );
  END IF;

  v_new_credits := v_current_credits - p_credits_to_charge;

  UPDATE public.profiles
    SET credits = v_new_credits
    WHERE id = p_profile_id;

  INSERT INTO public.briefs (profile_id, input_url, status, episode_duration_seconds, credits_charged, environment)
    VALUES (p_profile_id, p_episode_url, 'queued', p_duration_seconds, p_credits_to_charge, p_environment)
    RETURNING id INTO v_brief_id;

  INSERT INTO public.credit_ledger (profile_id, delta_credits, credits_left, reason, environment)
    VALUES (p_profile_id, -p_credits_to_charge, v_new_credits,
            'brief:' || v_brief_id::text, p_environment);

  RETURN jsonb_build_object(
    'brief_id', v_brief_id,
    'credits_charged', p_credits_to_charge,
    'credits_remaining', v_new_credits
  );
END;
$$;

-- 3b. Atomic credit consumption for brief regeneration.
-- Free within 24h of completion, full price after. API route (Session 3) computes which.
-- p_credits_to_charge = 0 for free regen, = original credits for paid regen.
-- SECURITY: Locked to service_role only (revoke at bottom of file).
CREATE OR REPLACE FUNCTION public.consume_credits_and_regenerate_brief(
  p_profile_id uuid,
  p_brief_id uuid,
  p_credits_to_charge integer,
  p_environment text DEFAULT 'DEVELOPMENT'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_credits integer;
  v_new_credits integer;
  v_updated_count integer;
BEGIN
  SELECT credits INTO v_current_credits
    FROM public.profiles
    WHERE id = p_profile_id
    FOR UPDATE;

  IF v_current_credits IS NULL THEN
    RETURN jsonb_build_object('error', 'profile_not_found');
  END IF;

  IF p_credits_to_charge > 0 AND v_current_credits < p_credits_to_charge THEN
    RETURN jsonb_build_object(
      'error', 'insufficient_credits',
      'credits_remaining', v_current_credits
    );
  END IF;

  v_new_credits := v_current_credits - p_credits_to_charge;

  -- Atomic reset. WHERE regeneration_count = 0 ensures only the first request wins.
  -- credits_charged is updated to the regen cost ONLY if it was a paid regen.
  -- The profile_id check in WHERE is defense-in-depth (matches auth check above).
  UPDATE public.briefs
    SET status = 'queued',
        "references" = NULL,
        error_log = NULL,
        started_at = NULL,
        completed_at = NULL,
        regeneration_count = 1,
        credits_charged = CASE WHEN p_credits_to_charge > 0 THEN p_credits_to_charge ELSE credits_charged END
    WHERE id = p_brief_id
      AND profile_id = p_profile_id
      AND status = 'complete'
      AND regeneration_count = 0;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count = 0 THEN
    RETURN jsonb_build_object('error', 'already_regenerated');
  END IF;

  IF p_credits_to_charge > 0 THEN
    UPDATE public.profiles
      SET credits = v_new_credits
      WHERE id = p_profile_id;

    INSERT INTO public.credit_ledger (profile_id, delta_credits, credits_left, reason, environment)
      VALUES (p_profile_id, -p_credits_to_charge, v_new_credits,
              'regen:' || p_brief_id::text, p_environment);
  END IF;

  RETURN jsonb_build_object(
    'credits_charged', p_credits_to_charge,
    'credits_remaining', v_new_credits
  );
END;
$$;

-- 4. Atomic credit increment — SERVICE ROLE ONLY.
-- Used by the webhook (Session 2) to add credits after Stripe payment.
-- SECURITY: Revoke execute from public and authenticated roles so only the service-role
-- client (which bypasses RLS and default grants) can call this. An authenticated user
-- calling supabase.rpc("increment_credits") will get "permission denied".
CREATE OR REPLACE FUNCTION public.increment_credits(p_profile_id uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_credits integer;
BEGIN
  UPDATE public.profiles SET credits = credits + p_amount WHERE id = p_profile_id RETURNING credits INTO v_new_credits;
  RETURN v_new_credits;
END;
$$;

-- Lock down ALL credit RPCs to service_role only.
-- These are called from Next.js API routes (server-side Supabase client with service key),
-- never directly from the browser. This prevents authenticated users from calling RPCs
-- directly to bypass business rules (e.g. passing p_credits_to_charge=0 for a paid brief).
REVOKE EXECUTE ON FUNCTION public.consume_credits_and_queue_brief(uuid, text, integer, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.consume_credits_and_queue_brief(uuid, text, integer, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.consume_credits_and_queue_brief(uuid, text, integer, integer, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.consume_credits_and_regenerate_brief(uuid, uuid, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.consume_credits_and_regenerate_brief(uuid, uuid, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.consume_credits_and_regenerate_brief(uuid, uuid, integer, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.increment_credits(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_credits(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_credits(uuid, integer) TO service_role;

-- 5. 3 free credits on signup — modify existing handle_new_user trigger
-- NOTE: Existing users (signed up before this migration) keep credits=0. Intentional.
-- NOTE: The ledger row defaults to environment='PRODUCTION' because APP_ENV is not
-- available in the trigger context. Accepted cosmetic mismatch for dev/staging signups.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, image, credits)
  VALUES (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url',
    3
  );
  INSERT INTO public.credit_ledger (profile_id, delta_credits, credits_left, reason)
  VALUES (new.id, 3, 3, 'signup_bonus');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
