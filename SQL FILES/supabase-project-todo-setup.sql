-- ============================================================================
-- Project To-Do — Notion-style checklist for each project.
--
-- Powers project-to-do.html (big items, click one to open its checklist in a
-- side panel) and the "Project To-Do" section of staff-to-do.html (each
-- staff member's own assigned, still-open checklist items across every
-- project).
--
-- Two tables:
--   project_todo_items    — the "big items" (e.g. "Site Prep", "Permitting").
--                            Title only; click one on project-to-do.html to
--                            open its checklist.
--   project_todo_subitems — the checklist rows under a big item. Each one
--                            can be assigned to a staff member and checked
--                            off. project_id is denormalized here (in
--                            addition to living on the parent big item) so
--                            staff-to-do.html can query "everything assigned
--                            to me" with one simple filter instead of a join.
--
-- Same conventions as the rest of this app: no Supabase Auth, so RLS is
-- permissive-to-anon with access control enforced client-side.
-- ============================================================================

create table if not exists public.project_todo_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  created_by_id uuid references public.staff_users(id),
  created_by_name text
);

create index if not exists project_todo_items_project_id_idx on public.project_todo_items (project_id);

alter table public.project_todo_items enable row level security;

drop policy if exists "project_todo_items_all_anon" on public.project_todo_items;
create policy "project_todo_items_all_anon"
  on public.project_todo_items
  for all
  to anon
  using (true)
  with check (true);


create table if not exists public.project_todo_subitems (
  id uuid primary key default gen_random_uuid(),
  todo_item_id uuid not null references public.project_todo_items(id) on delete cascade,
  -- Denormalized from the parent todo_item so staff-to-do.html can filter
  -- "assigned to me" directly, without joining through project_todo_items.
  project_id uuid not null references public.projects(id) on delete cascade,
  label text not null,
  assigned_to uuid references public.staff_users(id),
  assigned_to_name text,
  completed boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_todo_subitems_todo_item_id_idx on public.project_todo_subitems (todo_item_id);
create index if not exists project_todo_subitems_project_id_idx on public.project_todo_subitems (project_id);
create index if not exists project_todo_subitems_assigned_to_idx on public.project_todo_subitems (assigned_to);

alter table public.project_todo_subitems enable row level security;

drop policy if exists "project_todo_subitems_all_anon" on public.project_todo_subitems;
create policy "project_todo_subitems_all_anon"
  on public.project_todo_subitems
  for all
  to anon
  using (true)
  with check (true);


-- Keep updated_at current whenever a checklist item is edited/checked off.
create or replace function public.set_project_todo_subitems_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists project_todo_subitems_set_updated_at on public.project_todo_subitems;
create trigger project_todo_subitems_set_updated_at
  before update on public.project_todo_subitems
  for each row
  execute function public.set_project_todo_subitems_updated_at();
