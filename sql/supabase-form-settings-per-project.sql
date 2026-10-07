-- ============================================================================
-- Form Settings (2026-10-07): moves two things that used to be set once for
-- the whole company into a per-project "Form Settings" popup on the
-- Incident Report page -- the default approver, and (client-side only, see
-- below) the BC/VPO Word template upload location.
--
-- Run this ONCE. It restructures incident_report_settings from a single
-- global row into one row per project, so re-running it will fail the
-- second time (the `id` column it drops won't exist anymore) -- that's
-- expected, same as this app's other one-time migrations.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. incident_report_settings: singleton -> one row per project.
--
-- Coleby: copy today's single company-wide default approver forward onto
-- every existing project, rather than starting every project blank (which
-- would otherwise block incident report submission on every project at
-- once until someone visited each one's new Form Settings popup).
-- ----------------------------------------------------------------------------

-- Loosen the old structure so it can hold more than one row. The primary
-- key constraint has to be dropped BEFORE dropping NOT NULL on `id` --
-- Postgres won't let a primary-key column go nullable while it's still
-- the primary key (errors 42P16, "column is in a primary key").
alter table public.incident_report_settings drop constraint if exists incident_report_settings_singleton;
alter table public.incident_report_settings drop constraint if exists incident_report_settings_pkey;
alter table public.incident_report_settings alter column id drop not null;
alter table public.incident_report_settings add column if not exists project_id uuid references public.projects(id) on delete cascade;

-- Backfill: one row per existing project, carrying forward today's one
-- company-wide default_approver_id/name.
insert into public.incident_report_settings (project_id, default_approver_id, default_approver_name)
select p.id, old.default_approver_id, old.default_approver_name
from public.projects p
cross join (
  select default_approver_id, default_approver_name
  from public.incident_report_settings
  where id = true
  limit 1
) old
where not exists (
  select 1 from public.incident_report_settings s2 where s2.project_id = p.id
);

-- The old singleton row (project_id is null on it) is now redundant --
-- its data has already been copied onto every project above.
delete from public.incident_report_settings where id = true;

alter table public.incident_report_settings drop column id;
alter table public.incident_report_settings alter column project_id set not null;
alter table public.incident_report_settings add constraint incident_report_settings_pkey primary key (project_id);

-- RLS policies (incident_report_settings_select / _update) reference the
-- table generically, not the old `id` column, so they still apply
-- unchanged -- nothing to re-create here.

-- New projects need their own row too, created automatically the moment
-- the project itself is (blank -- someone still has to pick an approver
-- from Form Settings before incident reports can be submitted on it).
create or replace function public.create_default_incident_report_settings_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.incident_report_settings (project_id)
  values (new.id)
  on conflict (project_id) do nothing;
  return new;
end;
$$;

drop trigger if exists projects_create_incident_report_settings on public.projects;
create trigger projects_create_incident_report_settings
  after insert on public.projects
  for each row execute function public.create_default_incident_report_settings_row();

-- set_incident_report_defaults() (the incident_reports BEFORE INSERT
-- trigger) now looks up THIS report's project's own row instead of the one
-- global row. Identical otherwise -- still blocks submission with a clear,
-- now project-specific error if nobody's set an approver for that project.
create or replace function public.set_incident_report_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approver_id uuid;
  v_approver_name text;
begin
  if new.submitted_by is null then
    new.submitted_by := public.current_staff_id();
  end if;

  select default_approver_id, default_approver_name
    into v_approver_id, v_approver_name
    from public.incident_report_settings
    where project_id = new.project_id;

  if v_approver_id is null then
    raise exception 'No default approver is set up for this project yet — set one from Form Settings on the Incident Report page before reports can be submitted for it.';
  end if;

  new.assigned_approver_id := v_approver_id;
  new.assigned_approver_name := v_approver_name;
  new.assigned_by_id := null;
  new.assigned_by_name := 'Default approver setting';
  new.assigned_at := now();
  new.status := 'pending_approval';

  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- 2. New permission: incident_reports.manage_template_settings.
--
-- The existing incident_reports.set_default_approver permission already
-- covers the Approval Settings tab (same action it always gated -- just
-- moved from its own card into the new popup, so it's reused as-is, not
-- replaced). Word Template Settings is a genuinely new, separate action
-- (previously folded into incident_reports.approve, which is really about
-- approving a report, not managing templates), so it gets granted
-- independently -- a workgroup can have one tab without the other.
-- ----------------------------------------------------------------------------

insert into public.permissions (key, category, page_label, label, description, governed_by, sort_order) values
  ('incident_reports.manage_template_settings', 'Incident Reports', 'Incident Report', 'Manage Word Template Settings', 'Upload or replace this project''s BC/VPO Word templates from Form Settings', 'workgroup', 59)
on conflict (key) do update set
  category = excluded.category, page_label = excluded.page_label, label = excluded.label,
  description = excluded.description, governed_by = excluded.governed_by, sort_order = excluded.sort_order;

-- Same default grant as the other admin-ish incident_reports permissions.
insert into public.workgroup_permissions (workgroup_id, permission_key)
select id, 'incident_reports.manage_template_settings' from public.workgroups where name in ('IT', 'Super Admin')
on conflict (workgroup_id, permission_key) do nothing;


-- ----------------------------------------------------------------------------
-- 3. Verification queries -- run after the above.
-- ----------------------------------------------------------------------------
--   select count(*) from public.incident_report_settings;                           -- should equal your project count
--   select project_id, default_approver_name from public.incident_report_settings;  -- every row should show today's old company-wide approver
--   select conname from pg_constraint where conrelid = 'public.incident_report_settings'::regclass; -- should show incident_report_settings_pkey on project_id, no more _singleton
--   select key from public.permissions where key = 'incident_reports.manage_template_settings'; -- one row
-- ============================================================================
