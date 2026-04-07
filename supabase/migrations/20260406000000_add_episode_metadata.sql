-- Episode metadata (populated by worker after transcribe step)
ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS podcast_name text;
ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS episode_title text;
ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS regeneration_count integer NOT NULL DEFAULT 0;

-- Environment column on credit_ledger for at-a-glance identification of test vs real data
ALTER TABLE public.credit_ledger ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'PRODUCTION';

-- All existing briefs are pre-launch test data
UPDATE public.briefs SET environment = 'STAGING' WHERE environment = 'PRODUCTION';
