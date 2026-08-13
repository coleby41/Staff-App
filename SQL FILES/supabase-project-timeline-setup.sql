-- ============================================================================
-- Project Timeline — Gantt chart data for each individual project.
--
-- Powers project-timeline.html (project-timeline.js). One project can have
-- any number of phases, tasks, and milestones, all in a single table
-- distinguished by `type`:
--
--   phase     — a top-level grouping bar (e.g. "Site Prep", "Framing").
--                Usually has its own start/end dates spanning its tasks.
--   task      — the normal work item. Optionally nested under a phase via
--                parent_id.
--   milestone — a single-point-in-time marker (e.g. "Permit Approved").
--                Rendered on the chart as a short marker rather than a
--                bar spanning a date range — only end_date really matters
--                for these, start_date is left null.
--
-- Same conventions as the rest of this app (project_todo_items and
-- friends): no Supabase Auth, so RLS is permissive-to-anon with access
-- control enforced client-side, and project_id cascades on delete so a
-- deleted project takes its whole timeline with it.
--
-- Dependencies are intentionally simple — one optional depends_on_id per
-- item, meaning "this can't start until that one finishes" (finish-to-start,
-- the only kind of dependency real construction scheduling usually needs).
-- No separate dependency-type table; that's a reasonable future upgrade if
-- more complex scheduling (start-to-start, lag time, etc.) is ever needed.
--
-- Note: project-to-do.html's checklist items (project_todo_subitems) that
-- have a due_date are shown on this timeline too, but are NOT copied into
-- this table — project-timeline.js reads them live alongside this table at
-- render time, so editing a due date on the to-do panel is automatically
-- reflected here with no sync step required.
-- ============================================================================

create table if not exists public.project_timeline_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  -- Lets a task be shown grouped under a phase. Phases and milestones are
  -- normally top-level (parent_id null), but nothing stops a milestone
  -- from belonging to a phase too.
  parent_id uuid references public.project_timeline_items(id) on delete cascade,

  -- Simple finish-to-start dependency: this item shouldn't start until
  -- depends_on_id's end_date. Nothing enforces that in the database (no
  -- Supabase Auth / all client-side, same as the rest of this app) —
  -- project-timeline.js is responsible for the "depends on" picker and for
  -- drawing the dependency arrow on the chart.
  depends_on_id uuid references public.project_timeline_items(id) on delete set null,

  type text not null default 'task' check (type in ('phase', 'task', 'milestone')),
  title text not null,
  description text,

  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'on_hold', 'completed')),
  progress integer not null default 0 check (progress >= 0 and progress <= 100),

  -- Milestones only really use end_date (the single date they land on).
  -- Phases/tasks use both.
  start_date date,
  end_date date,

  assigned_to uuid references public.staff_users(id),
  assigned_to_name text,

  -- Optional per-item color override (mainly useful for phases, so each
  -- one reads as its own visual band on the chart). Null = fall back to
  -- the default status-driven coloring in styles.css.
  color text,

  -- Manual ordering among siblings (same parent_id, same project).
  position integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_id uuid references public.staff_users(id),
  created_by_name text,

  constraint project_timeline_items_no_self_dependency check (depends_on_id is distinct from id),
  constraint project_timeline_items_no_self_parent check (parent_id is distinct from id)
);

create index if not exists project_timeline_items_project_id_idx on public.project_timeline_items (project_id);
create index if not exists project_timeline_items_parent_id_idx on public.project_timeline_items (parent_id);
create index if not exists project_timeline_items_depends_on_id_idx on public.project_timeline_items (depends_on_id);

alter table public.project_timeline_items enable row level security;

drop policy if exists "project_timeline_items_all_anon" on public.project_timeline_items;
create policy "project_timeline_items_all_anon"
  on public.project_timeline_items
  for all
  to anon
  using (true)
  with check (true);

-- Keep updated_at current whenever an item is edited (dates dragged,
-- status changed, progress updated, etc.) — same pattern as
-- project_todo_subitems.
create or replace function public.set_project_timeline_items_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists project_timeline_items_set_updated_at on public.project_timeline_items;
create trigger project_timeline_items_set_updated_at
  before update on public.project_timeline_items
  for each row
  execute function public.set_project_timeline_items_updated_at();
