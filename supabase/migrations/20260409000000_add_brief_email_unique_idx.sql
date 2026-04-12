-- Add completed_at to brief_email_deliveries so we can track which generation
-- attempt triggered each email. Unique index on (brief_id, completed_at) ensures
-- exactly one email per brief completion, while allowing new emails on regeneration.

alter table public.brief_email_deliveries
  add column if not exists completed_at timestamptz;

-- Ensure exactly one email per brief completion.
-- Regens produce a new completed_at, so a new email is allowed.
-- Retries/crashes of the same completion are blocked.
create unique index if not exists brief_email_deliveries_brief_completion_uidx
  on public.brief_email_deliveries (brief_id, completed_at);
