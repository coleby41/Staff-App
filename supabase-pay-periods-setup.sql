-- ============================================================================
-- pay_periods — powers the "Set Timesheet Period" card on payroll-tools.html
--
-- Replaces the old localStorage-only anchor-Thursday approach. Accounting
-- creates a row per pay period (explicit start + end date) via the
-- "Make a New Pay Period" popup; the "next payday" shown on the page is the
-- soonest period's end_date. The View Calendar popup reads every row here.
--
-- Custom auth model note (see memory / supabase-auth.js): this portal does
-- NOT use Supabase Auth — sign-in queries staff_users directly with the
-- anon key, so auth.uid() is always null. Standard RLS written against
-- auth.uid() would silently reject everything. Matching the pattern used
-- elsewhere in this app (e.g. announcements, companies), RLS here is open
-- to the anon role and access is enforced app-side (the Payroll Tools page
-- itself is gated to the Accounting/Super Admin groups in updateNavAccess()).
-- ============================================================================

create table if not exists public.pay_periods (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  created_by uuid references public.staff_users(id),
  created_at timestamptz not null default now(),
  constraint pay_periods_end_after_start check (end_date >= start_date)
);

create index if not exists pay_periods_end_date_idx on public.pay_periods (end_date);

alter table public.pay_periods enable row level security;

drop policy if exists "Allow anon read pay_periods" on public.pay_periods;
create policy "Allow anon read pay_periods"
  on public.pay_periods for select
  to anon
  using (true);

drop policy if exists "Allow anon insert pay_periods" on public.pay_periods;
create policy "Allow anon insert pay_periods"
  on public.pay_periods for insert
  to anon
  with check (true);

drop policy if exists "Allow anon update pay_periods" on public.pay_periods;
create policy "Allow anon update pay_periods"
  on public.pay_periods for update
  to anon
  using (true);

drop policy if exists "Allow anon delete pay_periods" on public.pay_periods;
create policy "Allow anon delete pay_periods"
  on public.pay_periods for delete
  to anon
  using (true);

-- If gen_random_uuid() errors when this file is run (pgcrypto not enabled on
-- this project), run this once first:
-- create extension if not exists pgcrypto;
