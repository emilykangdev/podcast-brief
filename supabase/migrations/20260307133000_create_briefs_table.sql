-- Briefs table for generated podcast briefs owned by a profile.

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'brief_status'
      and n.nspname = 'public'
  ) then
    create type public.brief_status as enum (
      'pending',
      'generating',
      'complete',
      'error'
    );
  end if;
end
$$;

create table if not exists public.briefs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  input_url text not null,
  output_markdown text,
  output_html text,
  status public.brief_status not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists briefs_profile_id_idx on public.briefs (profile_id);
create index if not exists briefs_status_idx on public.briefs (status);
create index if not exists briefs_created_at_idx on public.briefs (created_at desc);

drop trigger if exists update_briefs_updated_at on public.briefs;
create trigger update_briefs_updated_at
before update on public.briefs
for each row
execute function public.update_updated_at();

alter table public.briefs enable row level security;

drop policy if exists "read_own_briefs" on public.briefs;
create policy "read_own_briefs"
on public.briefs
for select
to authenticated
using (auth.uid() = profile_id);

drop policy if exists "update_own_briefs" on public.briefs;
create policy "update_own_briefs"
on public.briefs
for update
to authenticated
using (auth.uid() = profile_id)
with check (auth.uid() = profile_id);

drop policy if exists "insert_own_briefs" on public.briefs;
create policy "insert_own_briefs"
on public.briefs
for insert
to authenticated
with check (auth.uid() = profile_id);

drop policy if exists "delete_own_briefs" on public.briefs;
create policy "delete_own_briefs"
on public.briefs
for delete
to authenticated
using (auth.uid() = profile_id);

