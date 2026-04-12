-- Episode metadata (populated by worker after transcribe step)
ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS podcast_name text;
ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS episode_title text;
ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS regeneration_count integer NOT NULL DEFAULT 0;
