-- ============================================================================
-- Project To-Do — mark big items complete.
--
-- Adds a completed flag to project_todo_items (the "big items" on
-- project-to-do.html) so the list can show a Notion-style checkbox per row,
-- independent of the completed flag project_todo_subitems already has for
-- individual checklist rows.
-- ============================================================================

alter table public.project_todo_items
  add column if not exists completed boolean not null default false;
