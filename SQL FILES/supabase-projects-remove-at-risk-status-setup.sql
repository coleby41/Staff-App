-- ============================================================================
-- supabase-projects-remove-at-risk-status-setup.sql
--
-- Removes "At Risk" as a project status option. Run this AFTER
-- supabase-projects-status-fields-setup.sql.
--
-- Any existing project already marked 'at_risk' gets reassigned to
-- 'on_hold' (the closest "needs attention" status left) before the check
-- constraint is tightened, so this migration is safe to run even if
-- someone already used the status.
--
-- Run this in Supabase → SQL Editor.
-- ============================================================================

update public.projects
set status = 'on_hold'
where status = 'at_risk';

alter table public.projects
  drop constraint if exists projects_status_check;

alter table public.projects
  add constraint projects_status_check
  check (status in ('active', 'onboarding', 'on_hold', 'completed', 'archived'));
