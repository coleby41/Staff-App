-- ============================================================================
-- supabase-audit-log-write-during-project-delete-fix-setup.sql
--
-- Deleting a project still failed after supabase-audit-log-project-delete-
-- fix-setup.sql, with a DIFFERENT error this time:
--   insert or update on table "audit_log" violates foreign key constraint
--   "audit_log_project_id_fkey"
--   Key (project_id)=(...) is not present in table "projects".
--
-- That earlier fix made audit_log.project_id ON DELETE SET NULL, which
-- protects EXISTING audit_log rows when a project is deleted. It does
-- nothing for a BRAND NEW audit_log row being written mid-delete: deleting a
-- project cascades to delete its schedule_tasks and project_members rows,
-- and both of those tables have their own AFTER DELETE trigger
-- (audit_schedule_task_change / audit_project_members_change) that calls
-- write_audit_log(..., old.project_id, ...) to record "this task/member was
-- removed." By the time that fires, the project row it points at has
-- already been removed by the same DELETE — so the fresh audit_log INSERT
-- gets rejected by its own foreign key, and the whole delete rolls back.
--
-- Reproduced this exact error locally (same constraint name, same "not
-- present in table projects" wording) via a project_members cascade before
-- writing this fix, to confirm the cause rather than assume it.
--
-- FIX: teach write_audit_log() itself to check whether the project it's
-- about to reference still exists, and store NULL instead of failing when
-- it doesn't -- the same "keep the row, drop the dangling reference" choice
-- already made for existing rows via ON DELETE SET NULL, just applied at
-- write time instead of at delete time. Every audit trigger in the app
-- calls this one function, so fixing it here covers schedule_tasks and
-- project_members today and any future trigger that logs a project_id
-- during a cascading delete, without needing a matching fix in each one.
-- Ordinary calls (project still exists, or p_project_id was already null,
-- e.g. staff_users permission changes) behave exactly as before.
--
-- Safe to re-run (create or replace function).
-- Run this in Supabase → SQL Editor, AFTER
-- supabase-audit-log-project-delete-fix-setup.sql.
-- ============================================================================

create or replace function public.write_audit_log(
  p_action text, p_entity_type text, p_entity_id text,
  p_project_id uuid, p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
begin
  if p_project_id is not null and exists (select 1 from public.projects where id = p_project_id) then
    v_project_id := p_project_id;
  else
    v_project_id := null;
  end if;

  insert into public.audit_log (user_id, staff_id, project_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), public.current_staff_id(), v_project_id, p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;
