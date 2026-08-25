-- ============================================================================
-- supabase-schedule-system-schema.sql
--
-- Full ground-up rebuild of the project scheduling / Gantt data model,
-- replacing project_timeline_items. Powers the rebuilt project-timeline.html
-- / project-timeline.js.
--
-- WHY A REBUILD, NOT AN ALTER: project_timeline_items mixed phases, tasks,
-- and milestones into one polymorphic table with a single "depends_on_id"
-- (finish-to-start only) and no phase category. Coleby asked for four
-- dependency types, a fixed Pre-Construction/Buy Out/Construction/Close-Out
-- category on every task, and CPM (critical path) support — all of which are
-- much simpler and more reliable on a normalized relational structure than
-- bolted onto the old single table.
--
-- DESIGN NOTE — milestones live in schedule_tasks, not a separate table:
-- Coleby's own suggested schema (in his spec) proposed a standalone
-- schedule_milestones table. I deliberately merged it into schedule_tasks
-- instead (via item_type = 'task' | 'milestone'), because a separate
-- milestones table forces schedule_dependencies to point at "either a task
-- OR a milestone" (a polymorphic FK), which is exactly the kind of
-- relational ambiguity that causes real bugs (an FK that silently doesn't
-- enforce integrity, or two constraints that have to be kept in sync by
-- hand). With milestones as task rows, schedule_dependencies.predecessor/
-- successor is always a single, simple, enforced FK into schedule_tasks —
-- and status, is_critical, assignee, phase, filtering, sorting, and CPM all
-- work identically for both, with zero special-casing. This is a deliberate
-- improvement on the suggested schema, made under the explicit permission in
-- the spec to redesign it — flagging it clearly here and in the delivery
-- summary rather than silently deviating.
--
-- DESIGN NOTE — is_critical vs. computed critical path: is_critical is a
-- manual, user-set flag (the spec's explicit "Critical Task" field/checkbox)
-- stored on the row. The actual Critical Path Method calculation (forward/
-- backward pass over schedule_dependencies, honoring all four dependency
-- types + lag) is computed CLIENT-SIDE at render time from the loaded tasks
-- and dependencies — never stored. That keeps a stored, potentially-stale
-- computed value from ever silently disagreeing with the real graph after a
-- drag/resize, at the cost of recomputing it on every load (cheap for
-- realistic task counts). The UI distinguishes "flagged critical" (manual)
-- from "on the computed critical path" (derived) with separate indicators.
--
-- WHAT THIS FILE DOES NOT DO: it does not drop project_timeline_items. Real
-- project data may already live there. The data migration below copies it
-- into the new tables (preserving row ids, so nothing that referenced an old
-- id breaks); project_timeline_items itself is left in place, untouched, so
-- this migration is safe to run against production and easy to roll back
-- from (nothing is destroyed). Drop it yourself once you've verified the new
-- system — see the commented-out DROP at the very end.
--
-- PREREQUISITE: this assumes supabase-auth-rearchitecture-schema.sql has
-- already been run (current_staff_id(), is_project_member(), project_role(),
-- is_super_admin(), write_audit_log() must already exist — they're reused
-- here, not redefined) — confirmed already present in this database.
--
-- Run this in Supabase → SQL Editor, top to bottom, in one go.
-- ============================================================================


-- ============================================================================
-- 1. schedule_phases
--
-- A named grouping within a project (e.g. "Site Prep", "Foundation",
-- "Framing"). phase_type is the fixed Pre-Construction / Buy Out /
-- Construction / Close-Out category the spec's view toggle filters on — a
-- project can have several schedule_phases rows sharing the same phase_type
-- (e.g. multiple Construction-phase phases), but every phase belongs to
-- exactly one of the four.
-- ============================================================================

create table if not exists public.schedule_phases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  name text not null,
  phase_type text not null check (phase_type in ('pre_construction', 'buy_out', 'construction', 'close_out')),
  description text,

  -- Manual ordering among phases in this project (drag-to-reorder in the
  -- sidebar/task list) — persisted server-side per the spec's explicit
  -- "do not rely on the frontend to remember order" requirement.
  sort_order integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.staff_users(id),
  created_by_name text,
  updated_by uuid references public.staff_users(id),
  updated_by_name text
);

create index if not exists schedule_phases_project_id_idx on public.schedule_phases (project_id);
create index if not exists schedule_phases_project_sort_idx on public.schedule_phases (project_id, sort_order);


-- ============================================================================
-- 2. schedule_tasks
--
-- Every task AND every milestone (item_type distinguishes them — see the
-- design note at the top of this file). A row's phase_id is NOT NULL: the
-- spec requires every task to belong to exactly one of the four phases, and
-- an orphaned task is exactly the bug that constraint prevents.
--
-- duration_days is a generated column (never stored redundantly, never able
-- to drift from start/end_date — directly serves "no incorrect dates").
-- ============================================================================

create table if not exists public.schedule_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  phase_id uuid not null references public.schedule_phases(id) on delete restrict,

  -- Optional subtask nesting under another task (NOT the same as phase_id —
  -- every task/milestone still belongs to exactly one phase regardless of
  -- whether it also has a parent task). Nullable, self-referencing.
  parent_task_id uuid references public.schedule_tasks(id) on delete set null,

  item_type text not null default 'task' check (item_type in ('task', 'milestone')),

  name text not null,
  description text,
  notes text,

  -- Milestones store their single date in end_date and leave start_date
  -- null (they don't span a range). Tasks require both, end >= start.
  start_date date,
  end_date date not null,
  duration_days integer generated always as (
    case when start_date is null then null else (end_date - start_date + 1) end
  ) stored,

  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'at_risk', 'delayed', 'complete', 'on_hold')),
  progress_percent integer not null default 0 check (progress_percent between 0 and 100),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),

  -- Manual "Critical Task" flag — see design note at top of file for how
  -- this relates to the computed CPM critical path.
  is_critical boolean not null default false,

  assigned_user_id uuid references public.staff_users(id),
  assigned_user_name text,
  -- public."Companies" uses a bigint primary key, not uuid, unlike every
  -- other table this schema references (staff_users, projects, etc.) —
  -- confirmed directly against the real database after an initial uuid
  -- attempt failed with a 42804 foreign-key type-mismatch error.
  contractor_id bigint references public."Companies"(id),
  contractor_name text,

  -- Manual ordering within a phase (drag-to-reorder in the task list),
  -- persisted server-side.
  sort_order integer not null default 0,

  -- Cheap, generic extensibility bucket for construction-specific data the
  -- spec explicitly says not to design tables for yet (weather delay detail,
  -- change-order linkage, RFI/document/photo links, PM notes) — so those can
  -- be added later without another schema migration. weather_delay itself is
  -- promoted to a real column since the spec calls it out by name.
  weather_delay boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.staff_users(id),
  created_by_name text,
  updated_by uuid references public.staff_users(id),
  updated_by_name text,

  constraint schedule_tasks_no_self_parent check (parent_task_id is distinct from id),
  constraint schedule_tasks_dates_valid check (
    (item_type = 'milestone' and (start_date is null or start_date = end_date))
    or (item_type = 'task' and start_date is not null and end_date >= start_date)
  )
);

create index if not exists schedule_tasks_project_id_idx on public.schedule_tasks (project_id);
create index if not exists schedule_tasks_phase_id_idx on public.schedule_tasks (phase_id);
create index if not exists schedule_tasks_parent_task_id_idx on public.schedule_tasks (parent_task_id);
create index if not exists schedule_tasks_assigned_user_id_idx on public.schedule_tasks (assigned_user_id);
create index if not exists schedule_tasks_contractor_id_idx on public.schedule_tasks (contractor_id);
create index if not exists schedule_tasks_status_idx on public.schedule_tasks (status);
create index if not exists schedule_tasks_is_critical_idx on public.schedule_tasks (is_critical) where is_critical;
create index if not exists schedule_tasks_dates_idx on public.schedule_tasks (start_date, end_date);
create index if not exists schedule_tasks_project_phase_sort_idx on public.schedule_tasks (project_id, phase_id, sort_order);


-- ============================================================================
-- 3. schedule_dependencies
--
-- One row per dependency edge between two schedule_tasks rows (task or
-- milestone, either side). All four CPM dependency types are supported from
-- day one (finish_to_start is what the UI creates by default/first).
-- project_id is denormalized here (rather than requiring a join through
-- schedule_tasks) purely so its RLS policy can stay the same simple
-- is_project_member(project_id) shape as every other table below.
-- ============================================================================

create table if not exists public.schedule_dependencies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  predecessor_task_id uuid not null references public.schedule_tasks(id) on delete cascade,
  successor_task_id uuid not null references public.schedule_tasks(id) on delete cascade,
  dependency_type text not null default 'finish_to_start'
    check (dependency_type in ('finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish')),

  -- Working-day offset applied on top of the dependency (e.g. "start 2 days
  -- after predecessor finishes"). Defaults to 0 (no lag) — a cheap, standard
  -- CPM concept to include now rather than bolt on later.
  lag_days integer not null default 0,

  created_at timestamptz not null default now(),
  created_by uuid references public.staff_users(id),

  constraint schedule_dependencies_no_self_reference check (predecessor_task_id is distinct from successor_task_id),
  constraint schedule_dependencies_unique unique (predecessor_task_id, successor_task_id, dependency_type)
);

create index if not exists schedule_dependencies_project_id_idx on public.schedule_dependencies (project_id);
create index if not exists schedule_dependencies_predecessor_idx on public.schedule_dependencies (predecessor_task_id);
create index if not exists schedule_dependencies_successor_idx on public.schedule_dependencies (successor_task_id);

-- Cycle guard: a dependency graph with a cycle can't be scheduled (CPM's
-- forward/backward pass would never converge) — reject at insert/update time
-- rather than letting a bad edge corrupt every future critical-path
-- calculation. Walks forward from the new edge's successor; if it can ever
-- reach the new edge's predecessor, adding this edge would close a loop.
create or replace function public.prevent_schedule_dependency_cycle()
returns trigger
language plpgsql
as $$
declare
  reachable boolean;
begin
  with recursive downstream as (
    select new.successor_task_id as task_id
    union
    select sd.successor_task_id
    from public.schedule_dependencies sd
    join downstream d on sd.predecessor_task_id = d.task_id
  )
  select exists (select 1 from downstream where task_id = new.predecessor_task_id) into reachable;

  if reachable then
    raise exception 'This dependency would create a cycle (% already leads back to %).', new.successor_task_id, new.predecessor_task_id;
  end if;

  return new;
end;
$$;

drop trigger if exists schedule_dependencies_prevent_cycle on public.schedule_dependencies;
create trigger schedule_dependencies_prevent_cycle
  before insert or update on public.schedule_dependencies
  for each row execute function public.prevent_schedule_dependency_cycle();


-- ============================================================================
-- 4. updated_at / updated_by bookkeeping
--
-- One shared trigger function (rather than a bespoke one per table) that
-- keeps updated_at current, and fills in updated_by/updated_by_name from the
-- signed-in user if the client didn't already set them — a safety net, not
-- a replacement for the client setting them explicitly.
-- ============================================================================

create or replace function public.set_schedule_row_updated_meta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  if new.updated_by is null then
    new.updated_by = public.current_staff_id();
  end if;
  if new.updated_by_name is null then
    select full_name into new.updated_by_name from public.staff_users where id = new.updated_by;
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_phases_set_updated_meta on public.schedule_phases;
create trigger schedule_phases_set_updated_meta
  before update on public.schedule_phases
  for each row execute function public.set_schedule_row_updated_meta();

drop trigger if exists schedule_tasks_set_updated_meta on public.schedule_tasks;
create trigger schedule_tasks_set_updated_meta
  before update on public.schedule_tasks
  for each row execute function public.set_schedule_row_updated_meta();


-- ============================================================================
-- 5. Audit history — reuses the existing audit_log table / write_audit_log()
-- helper (from supabase-auth-rearchitecture-schema.sql), no new table
-- needed. Logs task_name/phase_name snapshots directly into metadata so the
-- history is still readable after the task itself is later deleted or moved
-- to a different phase.
-- ============================================================================

create or replace function public.audit_schedule_task_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  changed jsonb := '[]'::jsonb;
begin
  if tg_op = 'INSERT' then
    perform public.write_audit_log(
      'schedule_task_created', 'schedule_task', new.id::text, new.project_id,
      jsonb_build_object('task_name', new.name, 'item_type', new.item_type,
        'phase_id', new.phase_id, 'start_date', new.start_date, 'end_date', new.end_date)
    );
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform public.write_audit_log(
      'schedule_task_deleted', 'schedule_task', old.id::text, old.project_id,
      jsonb_build_object('task_name', old.name)
    );
    return old;
  end if;

  -- UPDATE: build a list of {field, old_value, new_value} for every field
  -- that actually changed, matching the spec's example log line ("Cole
  -- moved: Framing From: Aug 15→Sep 10 To: Aug 22→Sep 17").
  if old.start_date is distinct from new.start_date or old.end_date is distinct from new.end_date then
    changed := changed || jsonb_build_object('field', 'dates',
      'old_value', jsonb_build_object('start_date', old.start_date, 'end_date', old.end_date),
      'new_value', jsonb_build_object('start_date', new.start_date, 'end_date', new.end_date));
  end if;
  if old.status is distinct from new.status then
    changed := changed || jsonb_build_object('field', 'status', 'old_value', old.status, 'new_value', new.status);
  end if;
  if old.progress_percent is distinct from new.progress_percent then
    changed := changed || jsonb_build_object('field', 'progress_percent', 'old_value', old.progress_percent, 'new_value', new.progress_percent);
  end if;
  if old.phase_id is distinct from new.phase_id then
    changed := changed || jsonb_build_object('field', 'phase_id', 'old_value', old.phase_id, 'new_value', new.phase_id);
  end if;
  if old.is_critical is distinct from new.is_critical then
    changed := changed || jsonb_build_object('field', 'is_critical', 'old_value', old.is_critical, 'new_value', new.is_critical);
  end if;
  if old.assigned_user_id is distinct from new.assigned_user_id then
    changed := changed || jsonb_build_object('field', 'assigned_user_id', 'old_value', old.assigned_user_id, 'new_value', new.assigned_user_id);
  end if;

  if jsonb_array_length(changed) > 0 then
    perform public.write_audit_log(
      'schedule_task_updated', 'schedule_task', new.id::text, new.project_id,
      jsonb_build_object('task_name', new.name, 'changes', changed)
    );
  end if;

  return new;
end;
$$;

drop trigger if exists schedule_tasks_audit on public.schedule_tasks;
create trigger schedule_tasks_audit
  after insert or update or delete on public.schedule_tasks
  for each row execute function public.audit_schedule_task_change();


-- ============================================================================
-- 6. Row Level Security — same convention as the rest of this app's project-
-- scoped tables (see supabase-rls-lockdown.sql's project_timeline_items /
-- project_todo_items / project_todo_subitems loop): any project member can
-- read; project_admin / project_manager / staff can write (accounting and
-- viewer stay read-only on schedules, matching that existing convention).
-- ============================================================================

alter table public.schedule_phases enable row level security;
alter table public.schedule_tasks enable row level security;
alter table public.schedule_dependencies enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['schedule_phases', 'schedule_tasks', 'schedule_dependencies']
  loop
    execute format('drop policy if exists "%1$s_select_members" on public.%1$s', t);
    execute format('drop policy if exists "%1$s_write_members" on public.%1$s', t);

    execute format($f$
      create policy "%1$s_select_members" on public.%1$s for select to authenticated
      using (public.is_project_member(project_id))
    $f$, t);

    execute format($f$
      create policy "%1$s_write_members" on public.%1$s for all to authenticated
      using (public.project_role(project_id) in ('project_admin','project_manager','staff') or public.is_super_admin())
      with check (public.project_role(project_id) in ('project_admin','project_manager','staff') or public.is_super_admin())
    $f$, t);

    execute format('revoke all on public.%1$s from anon', t);
    execute format('grant select, insert, update, delete on public.%1$s to authenticated', t);
  end loop;
end $$;


-- ============================================================================
-- 7. Data migration from project_timeline_items — preserves row ids, so any
-- id that was already referenced elsewhere keeps working with no remapping.
-- Idempotent (ON CONFLICT DO NOTHING) — safe to re-run.
--
-- Old rows had no phase category, so every migrated phase defaults to
-- phase_type = 'construction' — re-categorize them into the right one of
-- the four via the new UI after this runs. Old top-level items (no
-- parent_id, i.e. not under any phase) land in a synthetic "Uncategorized
-- (from migration)" phase created per project, since every task now needs a
-- phase — move them to a real phase afterward.
-- ============================================================================

-- 7a. Phases (old type = 'phase') — id preserved.
insert into public.schedule_phases (id, project_id, name, phase_type, description, sort_order, created_at, updated_at, created_by, created_by_name)
select
  pti.id, pti.project_id, pti.title, 'construction', pti.description,
  pti.position, pti.created_at, pti.updated_at, pti.created_by_id, pti.created_by_name
from public.project_timeline_items pti
where pti.type = 'phase'
on conflict (id) do nothing;

-- 7b. One synthetic catch-all phase per project that has any orphaned
-- (top-level or parent-was-a-task, not a phase) old items, so 7c always has
-- somewhere valid to put phase_id.
insert into public.schedule_phases (project_id, name, phase_type, description, sort_order)
select distinct pti.project_id, 'Uncategorized (from migration)', 'construction',
  'Auto-created during the scheduling system rebuild for items that weren''t under a phase in the old timeline. Move these to a real phase.',
  -1
from public.project_timeline_items pti
where pti.type in ('task', 'milestone')
  and not exists (
    select 1 from public.project_timeline_items parent
    where parent.id = pti.parent_id and parent.type = 'phase'
  )
  and not exists (
    select 1 from public.schedule_phases sp
    where sp.project_id = pti.project_id and sp.name = 'Uncategorized (from migration)'
  );

-- 7c. Tasks + milestones — id preserved. phase_id = old parent_id when that
-- parent was actually a phase, otherwise the synthetic catch-all above.
-- parent_task_id is left null (the old schema had no task-under-task
-- nesting in practice — parent_id always meant "which phase").
insert into public.schedule_tasks (
  id, project_id, phase_id, item_type, name, description,
  start_date, end_date, status, progress_percent,
  assigned_user_id, assigned_user_name, sort_order,
  created_at, updated_at, created_by, created_by_name
)
select
  pti.id, pti.project_id,
  coalesce(
    (select parent.id from public.project_timeline_items parent where parent.id = pti.parent_id and parent.type = 'phase'),
    (select sp.id from public.schedule_phases sp where sp.project_id = pti.project_id and sp.name = 'Uncategorized (from migration)')
  ),
  case when pti.type = 'milestone' then 'milestone' else 'task' end,
  pti.title, pti.description,
  case when pti.type = 'milestone' then null else coalesce(pti.start_date, pti.end_date) end,
  coalesce(pti.end_date, pti.start_date),
  case pti.status when 'completed' then 'complete' else coalesce(pti.status, 'not_started') end,
  coalesce(pti.progress, 0),
  pti.assigned_to, pti.assigned_to_name, pti.position,
  pti.created_at, pti.updated_at, pti.created_by_id, pti.created_by_name
from public.project_timeline_items pti
where pti.type in ('task', 'milestone')
  and coalesce(pti.end_date, pti.start_date) is not null -- schedule_tasks.end_date is NOT NULL; a handful of very old rows may have neither date and can't be migrated automatically — check for these manually (see the NOTICE below)
on conflict (id) do nothing;

do $$
declare
  skipped integer;
begin
  select count(*) into skipped
  from public.project_timeline_items pti
  where pti.type in ('task', 'milestone') and pti.start_date is null and pti.end_date is null;

  if skipped > 0 then
    raise notice '% old timeline item(s) had no start_date or end_date at all and were NOT migrated — find them with: select * from project_timeline_items where type in (''task'',''milestone'') and start_date is null and end_date is null;', skipped;
  end if;
end $$;

-- 7d. Dependencies (old depends_on_id) — only where the predecessor is
-- itself a migrated task/milestone (a dependency on a phase has no
-- equivalent in the new model, since phases aren't schedulable items
-- anymore). All migrated as finish_to_start, matching the old schema's only
-- supported dependency semantics.
insert into public.schedule_dependencies (project_id, predecessor_task_id, successor_task_id, dependency_type)
select pti.project_id, pti.depends_on_id, pti.id, 'finish_to_start'
from public.project_timeline_items pti
where pti.depends_on_id is not null
  and exists (select 1 from public.schedule_tasks st where st.id = pti.depends_on_id)
  and exists (select 1 from public.schedule_tasks st where st.id = pti.id)
on conflict (predecessor_task_id, successor_task_id, dependency_type) do nothing;


-- ============================================================================
-- 8. Once you've verified the new system in production and no longer need
-- the old table for reference/rollback, drop it. Left commented out on
-- purpose — same pattern as staff_users.password_hash's deferred drop in
-- supabase-rls-lockdown.sql.
-- ============================================================================

-- drop table if exists public.project_timeline_items cascade;
