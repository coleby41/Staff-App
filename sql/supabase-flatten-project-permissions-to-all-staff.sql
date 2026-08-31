-- ============================================================================
-- supabase-flatten-project-permissions-to-all-staff.sql
--
-- Coleby, follow-up to supabase-open-project-access-to-all-staff.sql:
-- "make sure that everyone can delete and have the same permisions as
-- everyone" — confirmed (1) any staff member can delete a whole project
-- outright, not just that project's own admin/Super Admin, and (2) get rid
-- of "add/remove members and change their role" being a separate,
-- admin-only action — every staff member gets the same permissions as
-- everyone else, full stop.
--
-- The previous migration only widened READ (select). This one removes every
-- remaining is_project_member() / project_role() restriction on WRITE
-- (insert/update/delete) across every project-scoped table and storage
-- bucket, so there is no longer any distinction between a project's
-- "members"/"leadership" and everyone else for any action covered here.
--
-- NOT touched, on purpose:
--   - Financial-figure masking (projects_overview / has_financial_access())
--     on the `projects` table's contract_value / utility-account-number
--     columns. That's a separate, more sensitive concern (dollar figures,
--     account numbers) that wasn't part of this request — ask explicitly if
--     you want that opened too.
--   - staff_users, payroll, form_templates/submissions, vendor tags,
--     Companies, audit_log — none of those are project-scoped tables, so
--     none of them are affected by this file.
--   - is_project_member()/project_role() themselves are left defined (still
--     used by has_financial_access() and the projects_overview view) — just
--     no longer referenced by any policy this file touches.
--
-- Safe to re-run. Run in Supabase → SQL Editor, after
-- supabase-open-project-access-to-all-staff.sql.
-- ============================================================================


-- ============================================================================
-- 1. PROJECTS — delete opened to everyone; update opened to everyone too
--    (so "can delete it" and "can edit it" aren't inconsistent). Select and
--    insert were already open to every authenticated staff member.
-- ============================================================================

drop policy if exists "projects_update_members" on public.projects;
drop policy if exists "projects_update_authenticated" on public.projects;
create policy "projects_update_authenticated"
  on public.projects for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "projects_delete_admins" on public.projects;
drop policy if exists "projects_delete_authenticated" on public.projects;
create policy "projects_delete_authenticated"
  on public.projects for delete
  to authenticated
  using (true);


-- ============================================================================
-- 2. PROJECT_MEMBERS — add/remove people from a project, or change their
--    role, no longer admin-only. Select was already opened by the previous
--    migration.
-- ============================================================================

drop policy if exists "project_members_insert_admins" on public.project_members;
drop policy if exists "project_members_insert_authenticated" on public.project_members;
create policy "project_members_insert_authenticated"
  on public.project_members for insert
  to authenticated
  with check (true);

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


-- ============================================================================
-- 3. SCHEDULE_PHASES / SCHEDULE_TASKS / SCHEDULE_DEPENDENCIES (Timeline) —
--    the combined "_write_members" policy (insert+update+delete) no longer
--    requires project membership or a project_admin/project_manager/staff
--    role; any authenticated staff member qualifies.
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['schedule_phases', 'schedule_tasks', 'schedule_dependencies']
  loop
    execute format('drop policy if exists "%1$s_write_members" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_write_authenticated" on public.%1$s', t);
    execute format($f$
      create policy "%1$s_write_authenticated" on public.%1$s for all to authenticated
      using (true)
      with check (true)
    $f$, t);
  end loop;
end $$;


-- ============================================================================
-- 4. PROJECT_FILES — insert/update/delete opened to any authenticated staff
--    member (was: insert required project membership; update/delete
--    required being the uploader or project leadership).
-- ============================================================================

drop policy if exists "project_files_insert_members" on public.project_files;
drop policy if exists "project_files_insert_authenticated" on public.project_files;
create policy "project_files_insert_authenticated"
  on public.project_files for insert
  to authenticated
  with check (true);

drop policy if exists "project_files_update_owner_or_leadership" on public.project_files;
drop policy if exists "project_files_update_authenticated" on public.project_files;
create policy "project_files_update_authenticated"
  on public.project_files for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "project_files_delete_owner_or_leadership" on public.project_files;
drop policy if exists "project_files_delete_authenticated" on public.project_files;
create policy "project_files_delete_authenticated"
  on public.project_files for delete
  to authenticated
  using (true);


-- ============================================================================
-- 5. PROJECT_CONTACTS / PROJECT_ORGANIZATIONS / PROJECT_UTILITY_ACCOUNTS /
--    PROJECT_GOV_OFFICES (Accounts page) — same "insert/update/delete open
--    to anyone signed in" treatment as project_files above, for all four.
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['project_contacts', 'project_organizations', 'project_utility_accounts', 'project_gov_offices']
  loop
    execute format('drop policy if exists "%1$s_insert_members" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_insert_authenticated" on public.%1$s', t);
    execute format($f$
      create policy "%1$s_insert_authenticated" on public.%1$s for insert to authenticated
      with check (true)
    $f$, t);

    execute format('drop policy if exists "%1$s_update_owner_or_leadership" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_update_authenticated" on public.%1$s', t);
    execute format($f$
      create policy "%1$s_update_authenticated" on public.%1$s for update to authenticated
      using (true) with check (true)
    $f$, t);

    execute format('drop policy if exists "%1$s_delete_owner_or_leadership" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_delete_authenticated" on public.%1$s', t);
    execute format($f$
      create policy "%1$s_delete_authenticated" on public.%1$s for delete to authenticated
      using (true)
    $f$, t);
  end loop;
end $$;


-- ============================================================================
-- 6. PROJECT_TODO_ITEMS / PROJECT_TODO_SUBITEMS — same treatment as
--    Timeline above: the combined write policy no longer requires
--    membership or a specific role.
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['project_todo_items', 'project_todo_subitems']
  loop
    execute format('drop policy if exists "%1$s_write_members" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_write_authenticated" on public.%1$s', t);
    execute format($f$
      create policy "%1$s_write_authenticated" on public.%1$s for all to authenticated
      using (true)
      with check (true)
    $f$, t);
  end loop;
end $$;


-- ============================================================================
-- 7. STORAGE — project-documents (site plans / permit plans) and
--    project-covers: insert/update/delete no longer require project
--    membership. Select was already open on both.
-- ============================================================================

drop policy if exists "project_documents_members_write" on storage.objects;
drop policy if exists "project_documents_members_update" on storage.objects;
drop policy if exists "project_documents_members_delete" on storage.objects;
drop policy if exists "project_documents_write_authenticated" on storage.objects;
drop policy if exists "project_documents_update_authenticated" on storage.objects;
drop policy if exists "project_documents_delete_authenticated" on storage.objects;

create policy "project_documents_write_authenticated"
on storage.objects for insert to authenticated
with check (bucket_id = 'project-documents');

create policy "project_documents_update_authenticated"
on storage.objects for update to authenticated
using (bucket_id = 'project-documents');

create policy "project_documents_delete_authenticated"
on storage.objects for delete to authenticated
using (bucket_id = 'project-documents');

drop policy if exists "project_covers_members_write" on storage.objects;
drop policy if exists "project_covers_members_update" on storage.objects;
drop policy if exists "project_covers_members_delete" on storage.objects;
drop policy if exists "project_covers_write_authenticated" on storage.objects;
drop policy if exists "project_covers_update_authenticated" on storage.objects;
drop policy if exists "project_covers_delete_authenticated" on storage.objects;

create policy "project_covers_write_authenticated"
on storage.objects for insert to authenticated
with check (bucket_id = 'project-covers');

create policy "project_covers_update_authenticated"
on storage.objects for update to authenticated
using (bucket_id = 'project-covers');

create policy "project_covers_delete_authenticated"
on storage.objects for delete to authenticated
using (bucket_id = 'project-covers');

-- ============================================================================
-- Done. Sanity checks to run after this migration:
--   select tablename, policyname, cmd, qual, with_check from pg_policies
--     where tablename in ('projects','project_members','schedule_phases',
--       'schedule_tasks','schedule_dependencies','project_files',
--       'project_contacts','project_organizations','project_utility_accounts',
--       'project_gov_offices','project_todo_items','project_todo_subitems')
--     order by tablename, cmd;
--   -- every qual/with_check above should read "true", not a function call.
-- ============================================================================
