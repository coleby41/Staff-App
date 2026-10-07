-- ============================================================================
-- Form Settings fix (2026-10-07b): fixes the
--   "Failed to load resource: 406" / "Failed to save default approver"
-- error from the new Form Settings popup's Approval Settings tab.
--
-- Root cause, two parts:
--
--   1. incident_report_settings only ever had _select and _update RLS
--      policies. Row Level Security denies anything with no matching
--      policy at all, so there was never a way for ANYONE -- including
--      IT/Super Admin -- to INSERT a row into this table through the app,
--      only UPDATE an existing one.
--
--   2. Loading a project's approver setting uses .maybeSingle() (see
--      loadFsApproverSetting() in js/incident-report.js), which is fine
--      with zero rows -- it just leaves the popup showing no approver
--      picked yet. But saving used a plain .update(), which silently
--      matches zero rows when that project has no settings row of its own
--      (whether because it's genuinely missing one, or because RLS
--      filtered it out), and the .single() right after that throws on an
--      empty result -- that's the 406.
--
-- supabase-form-settings-per-project.sql's own backfill should have given
-- every project that existed at the time it ran a row, but there was no
-- INSERT policy to fall back on for anything that slipped through (a
-- project created in a gap before this fix, or any other edge case), and
-- no way to self-heal one short of running SQL by hand.
--
-- Pairs with the js/incident-report.js change that switches
-- saveFormSettingsApprover() from .update() to .upsert() -- that change
-- needs this INSERT policy to actually succeed when a row is missing.
--
-- Safe to re-run.
-- ============================================================================

-- 1. INSERT policy -- same IT/Super-Admin rule as the existing UPDATE policy,
--    so whoever can already change an approver can also create the row in
--    the first place.
drop policy if exists "incident_report_settings_insert" on public.incident_report_settings;
create policy "incident_report_settings_insert"
  on public.incident_report_settings for insert
  to authenticated
  with check (public.is_workgroup('IT') or public.is_super_admin());

-- 2. One-time backfill: give any project that's still missing a row a
--    blank one (no approver set yet), the same as what the create-project
--    trigger gives brand-new projects.
insert into public.incident_report_settings (project_id)
select p.id
from public.projects p
where not exists (
  select 1 from public.incident_report_settings s where s.project_id = p.id
);

-- ----------------------------------------------------------------------------
-- Verification -- run after the above.
-- ----------------------------------------------------------------------------
--   select count(*) from public.projects;
--   select count(*) from public.incident_report_settings;  -- should now match
--   select policyname from pg_policies where tablename = 'incident_report_settings'; -- _select, _insert, _update
-- ============================================================================
