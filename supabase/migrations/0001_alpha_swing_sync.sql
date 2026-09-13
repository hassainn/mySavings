-- ============================================================
-- Alpha Swing AI — cloud backup & sync schema
-- Per-user, Row-Level-Security protected.
-- Identity: Supabase email OTP (auth.users).
-- Safe to run more than once (idempotent).
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- Live sync store: one row per (user, key).
-- Holds the JSON blob for each synced localStorage key.
-- Last-write-wins by updated_at.
-- ------------------------------------------------------------
create table if not exists public.sync_state (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  key         text        not null,
  data        jsonb       not null,
  device      text,
  revision    bigint      not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);

-- ------------------------------------------------------------
-- Full point-in-time snapshots (manual backup / restore).
-- ------------------------------------------------------------
create table if not exists public.backups (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  label       text,
  snapshot    jsonb       not null,
  created_at  timestamptz not null default now()
);

create index if not exists backups_user_created_idx
  on public.backups (user_id, created_at desc);

-- ------------------------------------------------------------
-- Keep updated_at fresh on every update.
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sync_state_touch on public.sync_state;
create trigger sync_state_touch
  before update on public.sync_state
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- Row Level Security: a user can only ever read/write their own rows.
-- ------------------------------------------------------------
alter table public.sync_state enable row level security;
alter table public.backups    enable row level security;

drop policy if exists "sync_state_select_own" on public.sync_state;
drop policy if exists "sync_state_write_own"  on public.sync_state;
create policy "sync_state_select_own" on public.sync_state
  for select using (auth.uid() = user_id);
create policy "sync_state_write_own" on public.sync_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "backups_select_own" on public.backups;
drop policy if exists "backups_write_own"  on public.backups;
create policy "backups_select_own" on public.backups
  for select using (auth.uid() = user_id);
create policy "backups_write_own" on public.backups
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
