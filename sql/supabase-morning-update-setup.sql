-- ============================================================================
-- supabase-morning-update-setup.sql   (2026-09-30)
--
-- Backs the once-a-day "Good morning" page (pages/good-morning.html).
-- One row per staff member: when they last saw the page. js/morning-check.js
-- reads it on every page load to decide whether today's update has been
-- shown yet, and good-morning.js uses last_seen_at as the "since" cutoff for
-- "what changed" before stamping it with now().
--
-- Kept server-side (not localStorage) so it's once a day per PERSON, not per
-- browser -- seeing it on the office PC means it won't pop again on a phone.
--
-- Safe to re-run.
-- ============================================================================

create table if not exists public.morning_update_seen (
  staff_user_id uuid primary key references public.staff_users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  -- The calendar day (America/New_York) it was last seen, computed client-side
  -- so "today" means the office's day, not UTC's.
  last_seen_date date not null default current_date
);

alter table public.morning_update_seen enable row level security;

drop policy if exists "morning_update_seen_select_own" on public.morning_update_seen;
drop policy if exists "morning_update_seen_insert_own" on public.morning_update_seen;
drop policy if exists "morning_update_seen_update_own" on public.morning_update_seen;

create policy "morning_update_seen_select_own"
  on public.morning_update_seen for select
  to authenticated
  using (staff_user_id = public.current_staff_id());

create policy "morning_update_seen_insert_own"
  on public.morning_update_seen for insert
  to authenticated
  with check (staff_user_id = public.current_staff_id());

create policy "morning_update_seen_update_own"
  on public.morning_update_seen for update
  to authenticated
  using (staff_user_id = public.current_staff_id())
  with check (staff_user_id = public.current_staff_id());

revoke all on public.morning_update_seen from anon;
grant select, insert, update on public.morning_update_seen to authenticated;

-- Sanity check -- should list the three policies above:
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'morning_update_seen';
