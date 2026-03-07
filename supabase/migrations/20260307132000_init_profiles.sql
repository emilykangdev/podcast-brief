-- Initial profile schema for Supabase Auth + Stripe linkage.
-- Keep this migration as the source of truth instead of one-off Dashboard SQL.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text,
  email text,
  image text,
  customer_id text unique,
  price_id text,
  credits integer not null default 0,
  has_access boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  drop constraint if exists profiles_credits_non_negative;
alter table public.profiles
  add constraint profiles_credits_non_negative check (credits >= 0);

create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists update_profiles_updated_at on public.profiles;
create trigger update_profiles_updated_at
before update on public.profiles
for each row
execute function public.update_updated_at();

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, name, image)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

alter table public.profiles enable row level security;

drop policy if exists "read_own_profile_data" on public.profiles;
create policy "read_own_profile_data"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

drop policy if exists "update_own_profile_data" on public.profiles;
create policy "update_own_profile_data"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "insert_own_profile_data" on public.profiles;
create policy "insert_own_profile_data"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id);

drop policy if exists "delete_own_profile_data" on public.profiles;
create policy "delete_own_profile_data"
on public.profiles
for delete
to authenticated
using (auth.uid() = id);
