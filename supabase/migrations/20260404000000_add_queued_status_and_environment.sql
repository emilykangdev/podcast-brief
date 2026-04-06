-- Add 'queued' to the brief_status enum for the job queue
ALTER TYPE public.brief_status ADD VALUE 'queued';

-- Track when the worker claimed the job (NULL while queued)
ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS started_at timestamptz;

-- Environment isolation: DEVELOPMENT, STAGING, or PRODUCTION
-- Prevents staging/prod workers from stealing each other's jobs
ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'PRODUCTION';

-- Composite index for the poll query: SELECT ... WHERE status='queued' AND environment=... ORDER BY created_at
CREATE INDEX IF NOT EXISTS idx_briefs_status_env_created ON public.briefs (status, environment, created_at);
