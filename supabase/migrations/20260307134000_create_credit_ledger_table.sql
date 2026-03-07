-- Immutable credit history per profile.
-- `credits_left` is the post-transaction snapshot at the time of the row.

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  delta_credits integer not null,
  credits_left integer not null,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table public.credit_ledger
  drop constraint if exists credit_ledger_credits_left_non_negative;
alter table public.credit_ledger
  add constraint credit_ledger_credits_left_non_negative check (credits_left >= 0);

create index if not exists credit_ledger_profile_id_idx
  on public.credit_ledger (profile_id);

create index if not exists credit_ledger_created_at_idx
  on public.credit_ledger (created_at desc);

alter table public.credit_ledger enable row level security;

drop policy if exists "read_own_credit_ledger" on public.credit_ledger;
create policy "read_own_credit_ledger"
on public.credit_ledger
for select
to authenticated
using (auth.uid() = profile_id);

drop policy if exists "insert_own_credit_ledger" on public.credit_ledger;
create policy "insert_own_credit_ledger"
on public.credit_ledger
for insert
to authenticated
with check (auth.uid() = profile_id);
