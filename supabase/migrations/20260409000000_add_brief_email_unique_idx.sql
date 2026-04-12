-- Ensure only one email delivery row per brief (idempotency guard).
create unique index if not exists brief_email_deliveries_brief_id_uidx
  on public.brief_email_deliveries (brief_id);
