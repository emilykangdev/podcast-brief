-- Add structured references column to briefs table.
-- Stores enriched references as JSONB for cross-brief querying
-- (e.g. "which references appear most often across your briefs").
-- Shape: [{ "name": string, "url": string | null }]

alter table public.briefs
  add column if not exists "references" jsonb;
