-- ============================================================================
-- supabase-audit-log-project-delete-fix-setup.sql
--
-- Deleting a project currently fails outright:
--   update or delete on table "projects" violates foreign key constraint
--   "audit_log_project_id_fkey" on table "audit_log"
-- because audit_log.project_id was created with no ON DELETE clause
-- (supabase-auth-rearchitecture-schema.sql), which defaults to blocking
-- the delete. Every other project_id foreign key in the schema already
-- uses "on delete cascade" -- audit_log is the one exception, and that's
-- intentional: audit_log is an append-only security/audit trail (see that
-- file's own comment: "users should NOT be able to modify or delete their
-- own audit records"), so cascading the delete and silently wiping out a
-- project's audit history the moment the project itself is deleted would
-- defeat the whole point of keeping it.
--
-- The fix here is "on delete set null" instead of cascade: the audit_log
-- row itself is never touched (action, entity_type, entity_id, metadata,
-- staff_id, user_id, created_at all stay exactly as they were -- the full
-- historical record survives permanently), only its now-dangling
-- project_id reference is cleared once the project it pointed to is gone.
-- That's enough to let the delete succeed without breaking the
-- append-only guarantee.
--
-- Safe to re-run (drop-if-exists before re-adding).
-- Run this in Supabase -> SQL Editor.
-- ============================================================================

alter table public.audit_log
  drop constraint if exists audit_log_project_id_fkey;

alter table public.audit_log
  add constraint audit_log_project_id_fkey
  foreign key (project_id) references public.projects(id) on delete set null;
