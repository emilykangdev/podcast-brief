-- Environment column on credit_ledger for at-a-glance identification of test vs real data.
-- Defaults to PRODUCTION so existing rows are safe.
ALTER TABLE public.credit_ledger ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'PRODUCTION';
