-- Transcript cache keyed by deterministic UUID v5 of the episode guid.

create table if not exists public.transcripts (
  id uuid primary key,             -- UUID v5 from episode guid (not auto-generated)
  apple_url text not null,         -- original Apple Podcasts URL provided by user
  rss_url text,                    -- resolved RSS feed URL from iTunes Lookup API (null for Mode A)
  episode_guid text not null,
  episode_title text not null,
  episode_date text,
  audio_url text not null,
  duration_seconds integer,
  transcript_md text not null,
  created_at timestamptz not null default now()
);

create index if not exists transcripts_apple_url_idx on public.transcripts (apple_url);

alter table public.transcripts enable row level security;
-- No RLS policies — accessed exclusively via service role key.
