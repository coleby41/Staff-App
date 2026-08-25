-- ============================================================================
-- Project To-Do — due dates on checklist sub-items.
--
-- Adds an optional due_date to project_todo_subitems (the checklist rows
-- under a project-to-do.html big item, shown in the side panel next to the
-- assignee picker). Same "Overdue / Due today / Due tomorrow / <date>"
-- treatment as the personal task due dates already used on the dashboard's
-- My Tasks card and staff-to-do.html (see formatDueLabel in
-- dashboard scripts/task.js and staff-todo.js) — project-todo.js has its
-- own copy of that helper so this page doesn't need to load either script.
--
-- staff-to-do.html's "Project To-Do" section (assigned-to-me items across
-- every project) reads this same column too, so due dates set here show up
-- there as well.
-- ============================================================================

alter table public.project_todo_subitems
  add column if not exists due_date date;
