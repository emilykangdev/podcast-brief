-- Brief Email Deliveries table.
-- Tracks each email delivery attempt/result per brief.

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'brief_email_delivery_status'
      and n.nspname = 'public'
  ) then
    create type public.brief_email_delivery_status as enum (
      'queued',
      'sent',
      'delivered',
      'failed'
    );
  end if;
end
$$;

create table if not exists public.brief_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references public.briefs (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null default 'resend',
  provider_message_id text,
  status public.brief_email_delivery_status not null default 'queued',
  error text,
  payload jsonb,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists brief_email_deliveries_brief_id_idx
  on public.brief_email_deliveries (brief_id);

create index if not exists brief_email_deliveries_profile_id_idx
  on public.brief_email_deliveries (profile_id);

create index if not exists brief_email_deliveries_status_idx
  on public.brief_email_deliveries (status);

create index if not exists brief_email_deliveries_created_at_idx
  on public.brief_email_deliveries (created_at desc);

create unique index if not exists brief_email_deliveries_provider_message_id_uidx
  on public.brief_email_deliveries (provider, provider_message_id)
  where provider_message_id is not null;

drop trigger if exists update_brief_email_deliveries_updated_at on public.brief_email_deliveries;
create trigger update_brief_email_deliveries_updated_at
before update on public.brief_email_deliveries
for each row
execute function public.update_updated_at();

alter table public.brief_email_deliveries enable row level security;

drop policy if exists "read_own_brief_email_deliveries" on public.brief_email_deliveries;
create policy "read_own_brief_email_deliveries"
on public.brief_email_deliveries
for select
to authenticated
using (auth.uid() = profile_id);

drop policy if exists "insert_own_brief_email_deliveries" on public.brief_email_deliveries;
create policy "insert_own_brief_email_deliveries"
on public.brief_email_deliveries
for insert
to authenticated
with check (auth.uid() = profile_id);

drop policy if exists "update_own_brief_email_deliveries" on public.brief_email_deliveries;
create policy "update_own_brief_email_deliveries"
on public.brief_email_deliveries
for update
to authenticated
using (auth.uid() = profile_id)
with check (auth.uid() = profile_id);

drop policy if exists "delete_own_brief_email_deliveries" on public.brief_email_deliveries;
create policy "delete_own_brief_email_deliveries"
on public.brief_email_deliveries
for delete
to authenticated
using (auth.uid() = profile_id);

