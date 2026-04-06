-- Prevent duplicate briefs for the same episode while one is still in progress.
-- The API route checks before inserting, but this index makes it atomic (no TOCTOU race).
CREATE UNIQUE INDEX IF NOT EXISTS idx_briefs_dedup_in_progress
  ON public.briefs (input_url, profile_id)
  WHERE status IN ('queued', 'generating');
