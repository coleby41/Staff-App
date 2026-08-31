-- ============================================================================
-- supabase-open-project-access-to-all-staff.sql
--
-- Coleby: "make sure that everyone has access to project files and
-- everything in that project" — every signed-in staff member, regardless of
-- workgroup or whether they're a project_members row for that specific
-- project, should be able to VIEW every page in the Projects section
-- (Project Overview, Project Files, Timeline, To-Do, Accounts) and
-- everything filed under a project.
--
-- Two things were actually blocking that:
--
-- 1. nav-access.js's "project_overview" nav key was never seeded into
--    workgroup_nav_access for any workgroup (supabase-workgroups-setup.sql's
--    original seed list only covers dashboard/new_project/excel_workbook/
--    form_templates/personal_finance/vendor_contacts) — so unless someone
--    manually granted it per workgroup from the Workgroups tab, the
--    "Projects" sidebar link was hidden for everyone below Super Admin, and
--    anyone who landed on project-home.html directly got redirected straight
--    back to the dashboard.
--
-- 2. Every project-content table (schedule_phases/tasks/dependencies,
--    project_files, project_contacts/organizations/utility_accounts/
--    gov_offices, project_todo_items/subitems) and the project-documents
--    storage bucket only let SELECT through for public.is_project_member() —
--    i.e. only staff explicitly added as a member of that one project could
--    see its files/timeline/to-dos/accounts at all.
--
-- This migration follows the exact precedent Coleby already set on the
-- `projects` table itself (see supabase-rls-lockdown.sql, "2026-08-19" note)
-- when asked for every logged-in staff member to see any project's
-- Overview: widen READ access only. Nothing about who can CREATE, EDIT, or
-- DELETE this content changes — insert stays open to any authenticated
-- staff member exactly as it already was on most of these tables, and
-- update/delete stay gated to the uploader/creator or project leadership
-- (project_admin/project_manager) or Super Admin, same as today. Financial
-- fields on the `projects` table itself are still masked per-row by
-- has_financial_access() through projects_overview — untouched by this file.
--
-- Safe to re-run. Run this in Supabase → SQL Editor, once, after the schema/
-- RLS-lockdown/schedule-system/project-files/project-accounts-contacts
-- migrations it depends on (same prerequisite order as everything else in
-- this app's sql/ folder).
-- ============================================================================


-- ============================================================================
-- 1. Seed the missing "project_overview" nav key for every workgroup, so the
--    Projects sidebar link shows up and project-home.html's own page gate
--    stops redirecting anyone away. Additive only (on conflict do nothing) —
--    doesn't touch any other nav key a workgroup already has configured.
-- ============================================================================
insert into public.workgroup_nav_access (workgroup_id, nav_key)
select id, 'project_overview' from public.workgroups
on conflict (workgroup_id, nav_key) do nothing;


-- ============================================================================
-- 2. Widen SELECT to every authenticated staff member on every table that
--    holds "content that lives inside a project" — Timeline, Files, To-Do,
--    Accounts, and the project_members roster itself. Write policies
--    (insert/update/delete) are untouched.
-- ============================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'schedule_phases', 'schedule_tasks', 'schedule_dependencies',
    'project_files',
    'project_contacts', 'project_organizations', 'project_utility_accounts', 'project_gov_offices',
    'project_todo_items', 'project_todo_subitems'
  ]
  loop
    execute format('drop policy if exists "%1$s_select_members" on public.%1$s', t);
    execute format($f$
      create policy "%1$s_select_authenticated" on public.%1$s for select to authenticated
      using (true)
    $f$, t);
  end loop;
end $$;

-- project_members has its own select-policy name (not the "_select_members"
-- convention the loop above targets).
drop policy if exists "project_members_select_fellow_members" on public.project_members;
create policy "project_members_select_authenticated"
  on public.project_members for select
  to authenticated
  using (true);


-- ============================================================================
-- 3. project-documents storage bucket (site plans / permit plans): split the
--    old single "for all" membership-gated policy into an open SELECT policy
--    (so any staff member can view/download a project's uploaded documents)
--    plus insert/update/delete policies that keep the existing
--    is_project_member() requirement for actually adding/changing/removing
--    files — same shape already used for the project-covers bucket.
-- ============================================================================
drop policy if exists "project_documents_authenticated" on storage.objects;

create policy "project_documents_select_authenticated"
on storage.objects for select to authenticated
using (bucket_id = 'project-documents');

create policy "project_documents_members_write"
on storage.objects for insert to authenticated
with check (bucket_id = 'project-documents' and public.is_project_member(public.try_uuid((storage.foldername(name))[1])));

create policy "project_documents_members_update"
on storage.objects for update to authenticated
using (bucket_id = 'project-documents' and public.is_project_member(public.try_uuid((storage.foldername(name))[1])));

create policy "project_documents_members_delete"
on storage.objects for delete to authenticated
using (bucket_id = 'project-documents' and public.is_project_member(public.try_uuid((storage.foldername(name))[1])));

-- ============================================================================
-- Done. Sanity checks to run after this migration:
--   select w.name, a.nav_key from public.workgroups w
--     join public.workgroup_nav_access a on a.workgroup_id = w.id
--     where a.nav_key = 'project_overview';                 -- one row per workgroup
--   select polname from pg_policies where tablename = 'project_members';  -- confirms the rename
-- ============================================================================
