-- ============================================================================
-- supabase-notifications-rls-fix.sql   (2026-09-30)
--
-- WHY NOTIFICATIONS STOPPED WORKING:
-- The `notifications` table was never included in supabase-rls-lockdown.sql
-- (the Supabase Auth migration). Every other table got its old "to anon"
-- policies swapped for "to authenticated" ones -- this one didn't. Since the
-- migration, everyone signed in is the `authenticated` role, so:
--   * the bell's SELECT returns zero rows (RLS filters silently, no error)
--   * incident-report.js / account-activity.js INSERTs are rejected by RLS,
--     and that error was never checked, so nothing showed in the console.
--
-- OPTIONAL -- see what's there before running (Supabase -> SQL Editor):
--   select policyname, roles, cmd from pg_policies
--   where schemaname = 'public' and tablename = 'notifications';
--
-- Safe to re-run.
-- ============================================================================

alter table public.notifications enable row level security;

-- Drop every existing policy on the table (old anon ones had names that were
-- set in the dashboard, not in any SQL file here, so drop them all by lookup).
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'notifications'
  loop
    execute format('drop policy if exists %I on public.notifications', p.policyname);
  end loop;
end $$;

-- READ: your own notifications + broadcast ones (user_id is null).
-- Same filter notifications.js already applies client-side.
create policy "notifications_select_own"
  on public.notifications for select
  to authenticated
  using (user_id is null or user_id = public.current_staff_id());

-- CREATE: any signed-in staff member can notify someone else (that's how
-- incident reports ping the approver / the submitter).
create policy "notifications_insert_authenticated"
  on public.notifications for insert
  to authenticated
  with check (true);

-- IT / Super Admin can see and clean up everything.
create policy "notifications_all_it_admin"
  on public.notifications for all
  to authenticated
  using (public.is_workgroup('IT') or public.is_super_admin())
  with check (public.is_workgroup('IT') or public.is_super_admin());

revoke all on public.notifications from anon;
grant select, insert, update, delete on public.notifications to authenticated;

-- Sanity check -- should list the three policies above, all {authenticated}:
select policyname, roles, cmd from pg_policies
where schemaname = 'public' and tablename = 'notifications';
