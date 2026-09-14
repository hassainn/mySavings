-- ============================================================
-- Alpha Swing AI — approved-members allow-list
-- Manage who can log in from Supabase (add/remove rows here).
-- Run once in the Supabase SQL Editor of the alpha-swing project.
-- ============================================================

-- The list of approved emails. Locked down (RLS on, no API policies), so it is
-- never readable or writable through the public/anon API — only via the SQL
-- editor / dashboard Table Editor / service role.
create table if not exists public.approved_members (
  email       text primary key,
  note        text,
  added_at    timestamptz not null default now()
);

alter table public.approved_members enable row level security;
-- (Intentionally no policies: the table is invisible to the anon/publishable key.)

-- Approval check that does NOT expose the list. SECURITY DEFINER lets it read
-- the locked table; it only ever returns true/false for the email you pass.
create or replace function public.is_email_approved(check_email text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.approved_members
    where lower(email) = lower(trim(check_email))
  );
$$;

revoke all on function public.is_email_approved(text) from public;
grant execute on function public.is_email_approved(text) to anon, authenticated;

-- Seed the owner.
insert into public.approved_members (email, note)
values ('hassainn.mcsa@gmail.com', 'owner')
on conflict (email) do nothing;

-- ------------------------------------------------------------
-- To ADD a member later (SQL editor or Table Editor):
--   insert into public.approved_members (email, note)
--   values ('someone@example.com', 'family') on conflict do nothing;
-- To REMOVE a member:
--   delete from public.approved_members where email = 'someone@example.com';
-- ------------------------------------------------------------
