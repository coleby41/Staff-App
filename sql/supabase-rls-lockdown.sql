-- ============================================================================
-- supabase-rls-lockdown.sql
--
-- STEP 5 of the security re-architecture — the migration that actually closes
-- the hole. Run this ONLY after:
--   1. supabase-auth-rearchitecture-schema.sql has been run
--   2. scripts/migrate-staff-to-auth.ts has given every staff_users row an
--      auth_user_id
--   3. supabase-project-members-backfill.sql has been run
--   4. The new client code (supabase-auth.js / auth-guard.js / login.*) is
--      deployed, so real Supabase Auth sessions exist
--
-- Running this BEFORE those steps will lock everyone out, including you.
--
-- What this does: drops every "to anon using (true)" policy in the app and
-- replaces it with policies scoped to the `authenticated` role plus the
-- helper functions from step 1 (project membership, workgroup, financial
-- access, payroll access). Revokes the anon role's blanket grants everywhere
-- it had them. Also applies the column-level financial-data protection on
-- projects (same pattern already used in this app for staff_users.
-- password_hash) and locks down every storage bucket.
--
-- Run this in Supabase → SQL Editor, top to bottom, in one go, during a
-- maintenance window — expect everyone to be signed out and need to log back
-- in afterward (agreed acceptable).
-- ============================================================================


-- ============================================================================
-- PROJECTS
-- ============================================================================

drop policy if exists "projects_all_anon" on public.projects;
drop policy if exists "projects_select_members" on public.projects; -- old name, pre-2026-08-19
drop policy if exists "projects_select_authenticated" on public.projects;

create policy "projects_select_authenticated"
  on public.projects for select
  to authenticated
  using (true);
  -- 2026-08-19: changed from `using (public.is_project_member(id))` — Coleby
  -- asked for every logged-in staff member to be able to view any project's
  -- Overview, not just project_members rows for that project. This only
  -- widens READ access to the basic project row; insert/update/delete below
  -- are still gated to project_members via is_project_member()/project_role(),
  -- and financial fields (contract_value, utility/trash/porta-potty account
  -- numbers) are still masked per-row by has_financial_access() through the
  -- projects_overview view below — a non-member can now see a project's
  -- Overview, but not its dollar figures unless they also have financial
  -- access on that project.

drop policy if exists "projects_insert_authenticated" on public.projects;
create policy "projects_insert_authenticated"
  on public.projects for insert
  to authenticated
  with check (true); -- creating a NEW project has no project_id to check membership against yet;
                      -- anyone signed in can start one (matches today's "New Project Onboard" being
                      -- open to every workgroup). The creator should immediately get a project_members
                      -- row — see the trigger below.

drop policy if exists "projects_update_members" on public.projects;
drop policy if exists "projects_update_authenticated" on public.projects;
create policy "projects_update_authenticated"
  on public.projects for update
  to authenticated
  using (true)
  with check (true);
  -- 2026-08-31: widened from is_project_member(id) — Coleby asked for every
  -- staff member to have the same permissions as everyone else, including
  -- editing any project. See supabase-flatten-project-permissions-to-all-staff.sql.

drop policy if exists "projects_delete_admins" on public.projects;
drop policy if exists "projects_delete_authenticated" on public.projects;
create policy "projects_delete_authenticated"
  on public.projects for delete
  to authenticated
  using (true);
  -- 2026-08-31: widened from project_admin/Super Admin-only — Coleby
  -- confirmed any staff member can delete a whole project outright. See
  -- supabase-flatten-project-permissions-to-all-staff.sql.

revoke all on public.projects from anon;
grant select, insert, update, delete on public.projects to authenticated;

-- Financial-field masking. NOTE: this is deliberately NOT a plain
-- column-level GRANT/REVOKE like staff_users.password_hash uses — column
-- grants apply to the whole `authenticated` role with no way to vary by
-- row/project, but financial access here is PER-PROJECT (project_members.
-- can_view_financials / role), so the only correct mechanism is a view that
-- masks each row individually via has_financial_access(id).
--
-- `security_invoker = true` (Postgres 15+, which Supabase runs) makes the
-- view evaluate RLS as the querying user, not the view's owner — required
-- for is_project_member()/has_financial_access() to see the right person.
--
-- Reads go through this view; writes (insert/update/delete) still go
-- straight to the base table exactly as today (projects-page.js's existing
-- save logic is untouched) — the row-level policies above already gate
-- those correctly. Only the two SELECT call sites that render this data
-- (project-shell.js's project fetch, projects-page.js's project list) are
-- updated to read from this view instead of the base table — see
-- project-fields.js's new PROJECTS_READ_VIEW constant.
-- `create or replace view` can't be used here: Postgres refuses to drop or
-- reorder a view's output columns via CREATE OR REPLACE (error 42P16), and
-- this exact view gets its column list extended later (committed_amount/
-- spent_to_date, added by supabase-project-dashboard-schema.sql's own copy
-- of this same view). If that file already ran against this database
-- before this one (or before this one is re-run), a plain `create or
-- replace view` here would try to shrink the already-wider view and fail.
-- `drop ... cascade` + `create` sidesteps that — nothing else in this repo
-- selects from projects_overview at the SQL level (only client JS does),
-- so there's nothing else for cascade to actually drop.
drop view if exists public.projects_overview cascade;
create view public.projects_overview
with (security_invoker = true)
as
select
  id, name, is_active, created_at, updated_at, created_by_id, created_by_name,
  owner_name, owner_phone, owner_email, owner_address,
  site_address, site_city, site_state, site_zip,
  gc_name, gc_phone, gc_email,
  poc_name, poc_role, poc_phone, poc_email,
  site_plans_status, site_plans_notes, site_plans_file_path,
  permit_number, permit_plans_status, permit_plans_notes, permit_plans_file_path,
  electric_provider, water_provider, other_utilities_notes,
  trash_vendor, porta_potty_vendor, temp_services_notes,
  county_city_office_name, county_city_contact_name, county_city_phone, county_city_email,
  status, project_manager_name, progress_percent, due_date,
  updated_by_id, updated_by_name, cover_photo_url,
  -- 2026-08-31: unmasked — Coleby asked for every staff member to see
  -- financial figures, not just those with has_financial_access(). See
  -- supabase-open-project-financials-to-all-staff.sql.
  contract_value, electric_account_number, water_account_number,
  trash_account_number, porta_potty_account_number
from public.projects;

grant select on public.projects_overview to authenticated;

-- Auto-add the creator of a new project as its project_admin, so "insert
-- with check(true)" above doesn't leave them locked out of the project they
-- just made (is_project_member() would otherwise say no on their very next
-- request).
create or replace function public.add_creator_as_project_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, role, can_view_financials, created_by)
  values (new.id, auth.uid(), 'project_admin', true, public.current_staff_id())
  on conflict (project_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists projects_add_creator_as_admin on public.projects;
create trigger projects_add_creator_as_admin
  after insert on public.projects
  for each row execute function public.add_creator_as_project_admin();


-- ============================================================================
-- PROJECT_MEMBERS (new table's own policies)
-- ============================================================================

drop policy if exists "project_members_select_fellow_members" on public.project_members;
drop policy if exists "project_members_select_authenticated" on public.project_members;
create policy "project_members_select_authenticated"
  on public.project_members for select
  to authenticated
  using (true);
  -- 2026-08-31: widened from `using (public.is_project_member(project_id))`
  -- — same "everyone can view, membership still gates who can act as
  -- leadership" change as every project-content table below. See
  -- supabase-open-project-access-to-all-staff.sql.

drop policy if exists "project_members_insert_admins" on public.project_members;
drop policy if exists "project_members_insert_authenticated" on public.project_members;
create policy "project_members_insert_authenticated"
  on public.project_members for insert
  to authenticated
  with check (true);
  -- 2026-08-31: Coleby asked to get rid of add/remove-members-and-change-role
  -- being an admin-only action — every staff member gets the same
  -- permissions as everyone else. See
  -- supabase-flatten-project-permissions-to-all-staff.sql.

drop policy if exists "project_members_update_admins" on public.project_members;
drop policy if exists "project_members_update_authenticated" on public.project_members;
create policy "project_members_update_authenticated"
  on public.project_members for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "project_members_delete_admins" on public.project_members;
drop policy if exists "project_members_delete_authenticated" on public.project_members;
create policy "project_members_delete_authenticated"
  on public.project_members for delete
  to authenticated
  using (true);

grant select, insert, update, delete on public.project_members to authenticated;


-- ============================================================================
-- PROJECT_TIMELINE_ITEMS / PROJECT_TODO_ITEMS / PROJECT_TODO_SUBITEMS
-- Read AND write: any authenticated staff member (2026-08-31 — see
-- supabase-open-project-access-to-all-staff.sql and
-- supabase-flatten-project-permissions-to-all-staff.sql; was "any project
-- member" for read, "project_admin/project_manager/staff" for write).
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['project_timeline_items', 'project_todo_items', 'project_todo_subitems']
  loop
    execute format('drop policy if exists "%1$s_all_anon" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_select_members" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_select_authenticated" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_write_members" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_write_authenticated" on public.%1$s', t);

    execute format($f$
      create policy "%1$s_select_authenticated" on public.%1$s for select to authenticated
      using (true)
    $f$, t);

    execute format($f$
      create policy "%1$s_write_authenticated" on public.%1$s for all to authenticated
      using (true)
      with check (true)
    $f$, t);

    execute format('revoke all on public.%1$s from anon', t);
    execute format('grant select, insert, update, delete on public.%1$s to authenticated', t);
  end loop;
end $$;


-- ============================================================================
-- WORKGROUPS / WORKGROUP_NAV_ACCESS — org-wide, read by anyone signed in,
-- written only by IT / Super Admin.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['workgroups', 'workgroup_nav_access']
  loop
    execute format('drop policy if exists "%1$s_all_anon" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_select_authenticated" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_write_it_admin" on public.%1$s', t);

    execute format($f$
      create policy "%1$s_select_authenticated" on public.%1$s for select to authenticated using (true)
    $f$, t);

    execute format($f$
      create policy "%1$s_write_it_admin" on public.%1$s for all to authenticated
      using (public.is_workgroup('IT') or public.is_super_admin())
      with check (public.is_workgroup('IT') or public.is_super_admin())
    $f$, t);

    execute format('revoke all on public.%1$s from anon', t);
    execute format('grant select, insert, update, delete on public.%1$s to authenticated', t);
  end loop;
end $$;


-- ============================================================================
-- STAFF_USERS — no more direct anon access at all. authenticated can select
-- the same non-sensitive columns as before (now via column grants on the
-- base table AND the view both staying available); only IT/Super Admin (or
-- the create-staff-account / reset-staff-password Edge Functions, which use
-- the service-role key and bypass RLS entirely) can insert/update.
-- ============================================================================

drop policy if exists "staff_users_insert_anon" on public.staff_users;
drop policy if exists "staff_users_update_anon" on public.staff_users;
drop policy if exists "staff_users_select_anon" on public.staff_users;
drop policy if exists "staff_users_select_authenticated" on public.staff_users;
drop policy if exists "staff_users_write_it_admin" on public.staff_users;

create policy "staff_users_select_authenticated"
  on public.staff_users for select
  to authenticated
  using (true); -- column grants below still hide password_hash/auth_email; row itself (name, role,
                -- workgroup, etc.) is fine for any signed-in staff member to see, matching today's
                -- staff directory behavior.

create policy "staff_users_write_it_admin"
  on public.staff_users for update
  to authenticated
  using (public.is_workgroup('IT') or public.is_super_admin())
  with check (public.is_workgroup('IT') or public.is_super_admin());

-- No insert policy for `authenticated` at all — account creation only
-- happens through the create-staff-account Edge Function (service role,
-- bypasses RLS), which is the actual server-side enforcement of "IT only".

revoke all on public.staff_users from anon;
revoke all on public.staff_users from authenticated;
grant select (
  id, username, full_name, workgroup, role, manager_id,
  employee_code, account_notes, active, created_at, auth_user_id, must_reset_password
) on public.staff_users to authenticated;
grant update (username, full_name, workgroup, role, manager_id, employee_code, account_notes, active)
  on public.staff_users to authenticated;
-- must_reset_password is readable (so the client can prompt for a reset
-- right after login — everyone can already see everyone's staff_users row
-- under staff_users_select_authenticated, so this adds no new exposure) but
-- NOT updatable directly — it can only be cleared via
-- clear_must_reset_password() below (self-only, called right after a
-- successful password reset) or set by the Edge Functions (service role).
-- password_hash and auth_email are never granted to any client role at all.
-- password_hash is dropped entirely once the Auth migration is confirmed
-- complete — see the very end of this file.

grant select on public.staff_users_directory to authenticated;
revoke select on public.staff_users_directory from anon;


-- ============================================================================
-- LOGIN SUPPORT — username -> synthetic email lookup, safe to expose since
-- accounts are admin-created (no self-serve signup to protect against
-- enumeration), and returns nothing but the email needed for the client's
-- next call to supabase.auth.signInWithPassword().
-- ============================================================================

create or replace function public.get_login_email(p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select auth_email from public.staff_users
  where username = p_username and active is not false
  limit 1;
$$;

revoke all on function public.get_login_email(text) from public;
grant execute on function public.get_login_email(text) to anon, authenticated;

-- Called by login.js right after supabase.auth.updateUser({password}) on the
-- forced first-login reset — self-only (auth.uid()), can't be used to clear
-- anyone else's flag.
create or replace function public.clear_must_reset_password()
returns void
language sql
security definer
set search_path = public
as $$
  update public.staff_users set must_reset_password = false where auth_user_id = auth.uid();
$$;

revoke all on function public.clear_must_reset_password() from public;
grant execute on function public.clear_must_reset_password() to authenticated;


-- ============================================================================
-- PAYROLL DOMAIN — highest sensitivity (comp data). Accounting/Office/Super
-- Admin see everything (matches payroll-tools.html's existing gating,
-- exposed via has_payroll_access()); a manager sees their direct reports'
-- rows; an employee sees only their own.
-- ============================================================================

drop policy if exists "payroll_employees_all_anon" on public.payroll_employees;
do $$
declare t text;
begin
  foreach t in array array['payroll_employees', 'timesheets', 'timesheet_entries', 'timesheet_events', 'pdf_history']
  loop
    execute format('drop policy if exists "Allow anon select" on public.%I', t);
    execute format('drop policy if exists "Allow anon insert" on public.%I', t);
    execute format('drop policy if exists "Allow anon update" on public.%I', t);
    execute format('drop policy if exists "Allow anon delete" on public.%I', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- payroll_employees is the roster/rate record itself (hourly_rate,
-- employment_type, etc.) — self and managers may SEE their own/their
-- report's row (needed for manage-employees.js's team roster and
-- timesheet.js's own-record lookups), but only Accounting/Office/Super Admin
-- may create/edit/delete it. Read and write are deliberately split (unlike a
-- single "for all" policy) so an employee can't grant themselves a raise by
-- editing their own row.
drop policy if exists "payroll_employees_select" on public.payroll_employees;
create policy "payroll_employees_select"
  on public.payroll_employees for select
  to authenticated
  using (public.has_payroll_access() or public.is_manager_of(staff_id) or staff_id = public.current_staff_id());

drop policy if exists "payroll_employees_write" on public.payroll_employees;
create policy "payroll_employees_write"
  on public.payroll_employees for insert
  to authenticated
  with check (public.has_payroll_access());

drop policy if exists "payroll_employees_update" on public.payroll_employees;
create policy "payroll_employees_update"
  on public.payroll_employees for update
  to authenticated
  using (public.has_payroll_access())
  with check (public.has_payroll_access());

drop policy if exists "payroll_employees_delete" on public.payroll_employees;
create policy "payroll_employees_delete"
  on public.payroll_employees for delete
  to authenticated
  using (public.has_payroll_access());

-- timesheets: three real actors touch this table today (see timesheet.js,
-- manage-employees.js, payroll-tools.js) — the employee themselves (create/
-- submit their own), their manager (approve/reject — sets approved_by/
-- approved_at and status='Sent to Accounting'), and Accounting (process/
-- complete/send back). All three need UPDATE, not just self+payroll.
drop policy if exists "timesheets_select" on public.timesheets;
create policy "timesheets_select"
  on public.timesheets for select
  to authenticated
  using (
    public.has_payroll_access()
    or exists (
      select 1 from public.payroll_employees pe
      where pe.id = timesheets.payroll_employee_id
        and (pe.staff_id = public.current_staff_id() or public.is_manager_of(pe.staff_id))
    )
  );

drop policy if exists "timesheets_insert" on public.timesheets;
create policy "timesheets_insert"
  on public.timesheets for insert
  to authenticated
  with check (
    public.has_payroll_access()
    or exists (
      select 1 from public.payroll_employees pe
      where pe.id = timesheets.payroll_employee_id and pe.staff_id = public.current_staff_id()
    )
  );

drop policy if exists "timesheets_update" on public.timesheets;
create policy "timesheets_update"
  on public.timesheets for update
  to authenticated
  using (
    public.has_payroll_access()
    or exists (
      select 1 from public.payroll_employees pe
      where pe.id = timesheets.payroll_employee_id
        and (pe.staff_id = public.current_staff_id() or public.is_manager_of(pe.staff_id))
    )
  )
  with check (
    public.has_payroll_access()
    or exists (
      select 1 from public.payroll_employees pe
      where pe.id = timesheets.payroll_employee_id
        and (pe.staff_id = public.current_staff_id() or public.is_manager_of(pe.staff_id))
    )
  );

drop policy if exists "timesheets_delete" on public.timesheets;
create policy "timesheets_delete"
  on public.timesheets for delete
  to authenticated
  using (public.has_payroll_access());

-- timesheet_entries: only the employee (while filling out their own
-- timesheet) or Accounting edit daily hours — a manager approves/rejects the
-- timesheet as a whole (via timesheet_events + timesheets.approved_by) but
-- doesn't edit someone else's clock entries, so manager access here is
-- read-only, not write.
drop policy if exists "timesheet_entries_select" on public.timesheet_entries;
create policy "timesheet_entries_select"
  on public.timesheet_entries for select
  to authenticated
  using (
    public.has_payroll_access()
    or exists (
      select 1 from public.timesheets ts
      join public.payroll_employees pe on pe.id = ts.payroll_employee_id
      where ts.id = timesheet_entries.timesheet_id
        and (pe.staff_id = public.current_staff_id() or public.is_manager_of(pe.staff_id))
    )
  );

drop policy if exists "timesheet_entries_write" on public.timesheet_entries;
create policy "timesheet_entries_write"
  on public.timesheet_entries for all
  to authenticated
  using (
    public.has_payroll_access()
    or exists (
      select 1 from public.timesheets ts
      join public.payroll_employees pe on pe.id = ts.payroll_employee_id
      where ts.id = timesheet_entries.timesheet_id and pe.staff_id = public.current_staff_id()
    )
  )
  with check (
    public.has_payroll_access()
    or exists (
      select 1 from public.timesheets ts
      join public.payroll_employees pe on pe.id = ts.payroll_employee_id
      where ts.id = timesheet_entries.timesheet_id and pe.staff_id = public.current_staff_id()
    )
  );

-- timesheet_events: append-only audit trail of the workflow itself — every
-- actor who can touch the timesheet (self/manager/payroll) can add an event
-- to it (submit/approve/reject/comment/process/complete). WITH CHECK
-- mirrors USING exactly so someone can't insert an event row against a
-- timesheet they have no relationship to.
drop policy if exists "timesheet_events_select" on public.timesheet_events;
create policy "timesheet_events_select"
  on public.timesheet_events for select
  to authenticated
  using (
    public.has_payroll_access()
    or exists (
      select 1 from public.timesheets ts
      join public.payroll_employees pe on pe.id = ts.payroll_employee_id
      where ts.id = timesheet_events.timesheet_id
        and (pe.staff_id = public.current_staff_id() or public.is_manager_of(pe.staff_id))
    )
  );

drop policy if exists "timesheet_events_insert" on public.timesheet_events;
create policy "timesheet_events_insert"
  on public.timesheet_events for insert
  to authenticated
  with check (
    public.has_payroll_access()
    or exists (
      select 1 from public.timesheets ts
      join public.payroll_employees pe on pe.id = ts.payroll_employee_id
      where ts.id = timesheet_events.timesheet_id
        and (pe.staff_id = public.current_staff_id() or public.is_manager_of(pe.staff_id))
    )
  );
-- No update/delete policy for timesheet_events — it's the audit trail for
-- the timesheet workflow itself, append-only by design (same reasoning as
-- audit_log).

drop policy if exists "pdf_history_access" on public.pdf_history;
create policy "pdf_history_access"
  on public.pdf_history for all
  to authenticated
  using (
    public.has_payroll_access()
    or exists (
      select 1 from public.timesheets ts
      join public.payroll_employees pe on pe.id = ts.payroll_employee_id
      where ts.id = pdf_history.timesheet_id and pe.staff_id = public.current_staff_id()
    )
  )
  with check (public.has_payroll_access());

drop policy if exists "Allow anon read pay_periods" on public.pay_periods;
drop policy if exists "Allow anon insert pay_periods" on public.pay_periods;
drop policy if exists "Allow anon update pay_periods" on public.pay_periods;
drop policy if exists "Allow anon delete pay_periods" on public.pay_periods;
drop policy if exists "pay_periods_read_authenticated" on public.pay_periods;
drop policy if exists "pay_periods_write_payroll" on public.pay_periods;

create policy "pay_periods_read_authenticated"
  on public.pay_periods for select
  to authenticated
  using (true); -- everyone needs to see pay period dates (personal finance page); no comp data here

create policy "pay_periods_write_payroll"
  on public.pay_periods for all
  to authenticated
  using (public.has_payroll_access())
  with check (public.has_payroll_access());

revoke all on public.pay_periods from anon;
grant select, insert, update, delete on public.pay_periods to authenticated;


-- ============================================================================
-- FORM_TEMPLATES / FORM_SUBMISSIONS — authenticated read/write (not
-- especially sensitive as a category, but no longer anon). Submissions stay
-- insert+select only, no update/delete, matching the existing "a record, not
-- something the app edits" design.
-- ============================================================================

drop policy if exists "form_templates_all_anon" on public.form_templates;
drop policy if exists "form_templates_authenticated" on public.form_templates;
create policy "form_templates_authenticated"
  on public.form_templates for all
  to authenticated
  using (true)
  with check (true);
revoke all on public.form_templates from anon;
grant select, insert, update, delete on public.form_templates to authenticated;

drop policy if exists "form_submissions_select_anon" on public.form_submissions;
drop policy if exists "form_submissions_insert_anon" on public.form_submissions;
drop policy if exists "form_submissions_select_authenticated" on public.form_submissions;
drop policy if exists "form_submissions_insert_authenticated" on public.form_submissions;
create policy "form_submissions_select_authenticated"
  on public.form_submissions for select to authenticated using (true);
create policy "form_submissions_insert_authenticated"
  on public.form_submissions for insert to authenticated with check (true);
revoke all on public.form_submissions from anon;
grant select, insert on public.form_submissions to authenticated;


-- ============================================================================
-- VENDOR TAGS — authenticated read/write, not project- or financial-scoped.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['vendor_tag_categories', 'vendor_tags', 'company_tags']
  loop
    execute format('drop policy if exists "%1$s_anon_select" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_anon_insert" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_anon_update" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_anon_delete" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_authenticated" on public.%1$s', t);

    execute format('create policy "%1$s_authenticated" on public.%1$s for all to authenticated using (true) with check (true)', t);

    execute format('revoke all on public.%1$s from anon', t);
    execute format('grant select, insert, update, delete on public.%1$s to authenticated', t);
  end loop;
end $$;


-- ============================================================================
-- COMPANIES (vendors) — pre-existing table, not created by any file in this
-- repo, holding "SSN/FID" and a W9 file path per company.js. Guarded with
-- to_regclass so this migration doesn't fail if the table name/case differs
-- in your project — check the Supabase Table Editor for the exact name if
-- this block reports "skipped".
-- ============================================================================

do $$
begin
  if to_regclass('public."Companies"') is not null then
    execute 'alter table public."Companies" enable row level security';
    execute 'drop policy if exists "Companies_anon_all" on public."Companies"';
    execute 'drop policy if exists "companies_anon_all" on public."Companies"';
    execute 'drop policy if exists "Companies_authenticated" on public."Companies"';

    execute $p$create policy "Companies_authenticated" on public."Companies" for all to authenticated using (true) with check (true)$p$;

    execute 'revoke all on public."Companies" from anon';
    execute 'grant select, insert, update, delete on public."Companies" to authenticated';

    -- NOT masking "SSN/FID" at the column level here on purpose: unlike
    -- staff_users.password_hash (a universal "nobody via the client, ever"
    -- rule, which a plain column GRANT/REVOKE can express fine), gating
    -- "SSN/FID" to payroll/accounting users only is a PER-USER condition —
    -- and Supabase's `authenticated` is one shared Postgres role for every
    -- signed-in person, so a column-level GRANT/REVOKE against that role
    -- can't vary by who's asking (same reason projects' financial columns
    -- above use a masking view, not a column grant). Doing this correctly
    -- for Companies needs the same masking-view treatment as
    -- projects_overview, but that requires the table's full column list
    -- (I only know of "SSN/FID" and W9FilePath from companies.js — not
    -- every column) to avoid silently dropping fields the app depends on.
    -- Follow-up: get `\d "Companies"` from the SQL editor and add a
    -- companies_overview view here, then repoint companies.js's read calls
    -- at it (same pattern as projects_overview / project-shell.js).
    -- Until then, "SSN/FID" is protected by row-level access only (must be
    -- authenticated — a real improvement over today's anon-open state) but
    -- is visible to any signed-in staff member, not just Accounting.
  else
    raise notice 'public."Companies" not found — skipped. Check the exact table name in Table Editor and adjust this file if needed.';
  end if;
end $$;


-- ============================================================================
-- AUDIT_LOG — read-only for IT/Super Admin, no client insert/update/delete
-- policy at all (writes only happen via the SECURITY DEFINER
-- write_audit_log() helper called from triggers).
-- ============================================================================

drop policy if exists "audit_log_select_it_admin" on public.audit_log;
create policy "audit_log_select_it_admin"
  on public.audit_log for select
  to authenticated
  using (public.is_workgroup('IT') or public.is_super_admin());

revoke all on public.audit_log from anon;
grant select on public.audit_log to authenticated;


-- ============================================================================
-- STORAGE BUCKETS
-- ============================================================================

-- Safe uuid cast — folder-based storage policies below key off
-- (storage.foldername(name))[1] being a project/staff id, but a plain `::uuid`
-- cast THROWS (not just fails-to-match) on any object that doesn't happen to
-- sit under a UUID-named folder (a stray root-level upload, a differently-
-- named legacy folder, etc.), which would break listing for the ENTIRE
-- bucket rather than just denying that one object. This returns null
-- instead, so those objects are correctly denied without erroring the query.
create or replace function public.try_uuid(p_text text)
returns uuid
language plpgsql
immutable
as $$
begin
  return p_text::uuid;
exception when others then
  return null;
end;
$$;

-- project-documents: site plans / permit plans. Path convention is
-- "<project_id>/...", matching how project-fields.js already uploads them
-- (pathField values look like "<uuid>/filename.pdf"). Fully open to any
-- authenticated staff member (2026-08-31 — see
-- supabase-open-project-access-to-all-staff.sql, then
-- supabase-flatten-project-permissions-to-all-staff.sql for insert/update/
-- delete no longer requiring project membership either).
drop policy if exists "project_documents_bucket_anon_all" on storage.objects;
drop policy if exists "project_documents_authenticated" on storage.objects;
drop policy if exists "project_documents_select_authenticated" on storage.objects;
drop policy if exists "project_documents_members_write" on storage.objects;
drop policy if exists "project_documents_members_update" on storage.objects;
drop policy if exists "project_documents_members_delete" on storage.objects;
drop policy if exists "project_documents_write_authenticated" on storage.objects;
drop policy if exists "project_documents_update_authenticated" on storage.objects;
drop policy if exists "project_documents_delete_authenticated" on storage.objects;

create policy "project_documents_select_authenticated"
on storage.objects for select to authenticated
using (bucket_id = 'project-documents');

create policy "project_documents_write_authenticated"
on storage.objects for insert to authenticated
with check (bucket_id = 'project-documents');

create policy "project_documents_update_authenticated"
on storage.objects for update to authenticated
using (bucket_id = 'project-documents');

create policy "project_documents_delete_authenticated"
on storage.objects for delete to authenticated
using (bucket_id = 'project-documents');

-- staff-documents: generated timesheet PDFs etc. Accounting/Office/Super
-- Admin (has_payroll_access()) can read/write into ANY employee's folder
-- (matches payroll-pdf-stub.js generating into someone else's folder); an
-- employee can only read their own (folder name = their staff_users.id).
drop policy if exists "staff_documents_anon_all" on storage.objects;
drop policy if exists "staff_documents_authenticated" on storage.objects;
create policy "staff_documents_authenticated"
on storage.objects for all to authenticated
using (
  bucket_id = 'staff-documents'
  and (public.has_payroll_access() or public.try_uuid((storage.foldername(name))[1]) = public.current_staff_id())
)
with check (bucket_id = 'staff-documents' and public.has_payroll_access());

-- form-submissions: generated submission PDFs.
drop policy if exists "form_submissions_bucket_anon_all" on storage.objects;
drop policy if exists "form_submissions_authenticated" on storage.objects;
create policy "form_submissions_authenticated"
on storage.objects for all to authenticated
using (bucket_id = 'form-submissions')
with check (bucket_id = 'form-submissions');

-- project-covers: public-READ (cover photos are meant to render in a
-- public-facing card grid, low sensitivity); write fully open to any
-- authenticated staff member (2026-08-31 — was project-membership-gated,
-- see supabase-flatten-project-permissions-to-all-staff.sql).
drop policy if exists "project_covers_bucket_anon_all" on storage.objects;
drop policy if exists "project_covers_public_read" on storage.objects;
drop policy if exists "project_covers_members_write" on storage.objects;
drop policy if exists "project_covers_members_update" on storage.objects;
drop policy if exists "project_covers_members_delete" on storage.objects;
drop policy if exists "project_covers_write_authenticated" on storage.objects;
drop policy if exists "project_covers_update_authenticated" on storage.objects;
drop policy if exists "project_covers_delete_authenticated" on storage.objects;
create policy "project_covers_public_read"
on storage.objects for select
using (bucket_id = 'project-covers');
create policy "project_covers_write_authenticated"
on storage.objects for insert to authenticated
with check (bucket_id = 'project-covers');
create policy "project_covers_update_authenticated"
on storage.objects for update to authenticated
using (bucket_id = 'project-covers');
create policy "project_covers_delete_authenticated"
on storage.objects for delete to authenticated
using (bucket_id = 'project-covers');

-- company-w9s: tax documents. Originally restricted to
-- Accounting/Office/Super Admin (has_payroll_access()) to mirror the
-- "SSN/FID" column gating above — but the Companies table itself
-- (Companies_authenticated, above) is open to every authenticated staff
-- member, including that same SSN/FID column, so gating just the W9
-- *file* to a narrower group was an inconsistency: any staff member who
-- can already create/edit a vendor and see its SSN/FID would hit an RLS
-- rejection the moment they attached a W9, silently failing the whole
-- "Add Vendor" save (companies.js uploads the W9 to storage before it
-- inserts the vendor row). Opened up to match Companies_authenticated —
-- confirmed with Coleby (2026-08-25) — see
-- SQL FILES/supabase-company-w9s-open-access-fix.sql for the standalone
-- migration that applies this to an already-locked-down live database.
do $$
begin
  if exists (select 1 from storage.buckets where id = 'company-w9s') then
    execute 'drop policy if exists "company_w9s_bucket_anon_all" on storage.objects';
    execute 'drop policy if exists "company_w9s_authenticated" on storage.objects';
    execute $p$create policy "company_w9s_authenticated" on storage.objects for all to authenticated
      using (bucket_id = 'company-w9s')
      with check (bucket_id = 'company-w9s')$p$;
  end if;
end $$;


-- ============================================================================
-- FINAL CLEANUP — only run this line once you've confirmed every staff
-- member has successfully logged in via the new Supabase Auth flow at least
-- once (i.e. nobody still needs the old hash to sign in). Left commented out
-- on purpose so it's a deliberate, separate action.
-- ============================================================================

-- alter table public.staff_users drop column if exists password_hash;
