# Brief: Refund Policy for Failed Briefs

## Decision
No automatic refund on pipeline failure. Manual refund via Supabase SQL when a user reports it.

## Why
- Simple to implement (no code changes)
- Low volume — pipeline failures are rare
- Prevents abuse (someone finding a URL that always fails to farm free credits)
- Can revisit with auto-refund later if failure volume increases

## How to Refund
```sql
-- 1. Refund credits
UPDATE profiles SET credits = credits + <credits_charged> WHERE id = '<user_id>';

-- 2. Audit trail
INSERT INTO credit_ledger (profile_id, delta_credits, credits_left, reason, environment)
VALUES ('<user_id>', <credits_charged>,
  (SELECT credits FROM profiles WHERE id = '<user_id>'),
  'refund:brief_failure', '<ENVIRONMENT>');
```

Look up `credits_charged` from the failed brief row in `briefs` table.

## Rejected Alternatives
- **Auto-refund on pipeline failure** — could be abused, adds complexity to the worker
- **Free retry without re-charging** — complicates the dedup logic, brief row already exists with credits_charged
