-- Stores structured pipeline degradation events per brief run.
-- NULL = clean run. Non-null = at least one retry/partial-result/unrecoverable error occurred.
-- Query degraded briefs: SELECT id, error_log FROM briefs WHERE error_log IS NOT NULL;

ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS error_log jsonb DEFAULT null;
