-- ============================================================================
-- supabase-project-dashboard-schema.sql
--
-- Adds the data model behind the redesigned Project Overview dashboard:
-- RFIs, Change Orders, Submittals, Project Events, and an append-only
-- Project Activity feed, plus committed/spent financial tracking on
-- `projects`. Also closes an RLS gap on two tables that predate the
-- security re-architecture (project_timeline_items, project_todo_items,
-- project_todo_subitems still had "to anon using (true)" policies).
--
-- PREREQUISITE: run this only after the full security re-architecture is
-- rolled out (supabase-auth-rearchitecture-schema.sql +
-- supabase-project-members-backfill.sql + supabase-rls-lockdown.sql all
-- applied, and every staff member migrated to real Supabase Auth). This
-- file calls current_staff_id(), is_super_admin(), is_project_member(),
-- project_role(), and has_financial_access() directly — none of that
-- exists until those migrations have run.
--
-- Safe to run in one go, in the SQL Editor. Nothing here is destructive —
-- new tables, new columns, and RLS-policy replacements only.
-- ============================================================================


-- ============================================================================
-- 1. RFIs (Requests for Information)
-- ============================================================================

create table if not exists public.rfis (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  number integer not null,
  subject text not null,
  question text not null,
  status text not null default 'open' check (status in ('open', 'answered', 'closed')),
  asked_by uuid references public.staff_users(id),
  asked_by_name text,
  assigned_to uuid references public.staff_users(id),
  assigned_to_name text,
  due_date date,
  answer text,
  answered_by uuid references public.staff_users(id),
  answered_by_name text,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);

create index if not exists rfis_project_id_idx on public.rfis (project_id);
create index if not exists rfis_status_idx on public.rfis (project_id, status);

alter table public.rfis enable row level security;

drop policy if exists "rfis_select_members" on public.rfis;
create policy "rfis_select_members"
  on public.rfis for select
  to authenticated
  using (public.is_project_member(project_id));

drop policy if exists "rfis_insert_members" on public.rfis;
create policy "rfis_insert_members"
  on public.rfis for insert
  to authenticated
  with check (public.is_project_member(project_id));

-- Answering/closing is restricted to project leadership or whoever the RFI
-- is assigned to — anyone can ask a question, but only the right people can
-- close the loop on it.
drop policy if exists "rfis_update_answerers" on public.rfis;
create policy "rfis_update_answerers"
  on public.rfis for update
  to authenticated
  using (
    public.project_role(project_id) in ('project_admin', 'project_manager')
    or assigned_to = public.current_staff_id()
  )
  with check (
    public.project_role(project_id) in ('project_admin', 'project_manager')
    or assigned_to = public.current_staff_id()
  );

drop policy if exists "rfis_delete_admins" on public.rfis;
create policy "rfis_delete_admins"
  on public.rfis for delete
  to authenticated
  using (public.project_role(project_id) = 'project_admin');

revoke all on public.rfis from anon;
grant select, insert, update, delete on public.rfis to authenticated;

create or replace function public.set_rfis_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.number is null then
    select coalesce(max(number), 0) + 1 into new.number from public.rfis where project_id = new.project_id;
  end if;
  if new.asked_by is null then
    new.asked_by := public.current_staff_id();
  end if;
  return new;
end;
$$;

drop trigger if exists rfis_set_defaults on public.rfis;
create trigger rfis_set_defaults
  before insert on public.rfis
  for each row execute function public.set_rfis_defaults();

create or replace function public.set_rfis_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists rfis_set_updated_at on public.rfis;
create trigger rfis_set_updated_at
  before update on public.rfis
  for each row execute function public.set_rfis_updated_at();


-- ============================================================================
-- 2. Change Orders
-- ============================================================================

create table if not exists public.change_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  number integer not null,
  title text not null,
  description text,
  amount numeric not null default 0,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid references public.staff_users(id),
  requested_by_name text,
  approved_by uuid references public.staff_users(id),
  approved_by_name text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);

create index if not exists change_orders_project_id_idx on public.change_orders (project_id);
create index if not exists change_orders_status_idx on public.change_orders (project_id, status);

alter table public.change_orders enable row level security;

drop policy if exists "change_orders_select_members" on public.change_orders;
create policy "change_orders_select_members"
  on public.change_orders for select
  to authenticated
  using (public.is_project_member(project_id));

drop policy if exists "change_orders_insert_leadership" on public.change_orders;
create policy "change_orders_insert_leadership"
  on public.change_orders for insert
  to authenticated
  with check (public.project_role(project_id) in ('project_admin', 'project_manager', 'accounting'));

-- Approving/rejecting a dollar amount is gated to people who both have
-- financial visibility on this project AND hold a role authorized to
-- approve spend — matches the spec's "amount visibility gated to financial
-- roles," extended to the approval action itself, not just the number.
drop policy if exists "change_orders_update_approvers" on public.change_orders;
create policy "change_orders_update_approvers"
  on public.change_orders for update
  to authenticated
  using (
    public.has_financial_access(project_id)
    and public.project_role(project_id) in ('project_admin', 'accounting')
  )
  with check (
    public.has_financial_access(project_id)
    and public.project_role(project_id) in ('project_admin', 'accounting')
  );

drop policy if exists "change_orders_delete_admins" on public.change_orders;
create policy "change_orders_delete_admins"
  on public.change_orders for delete
  to authenticated
  using (public.project_role(project_id) = 'project_admin');

revoke all on public.change_orders from anon;
grant select, insert, update, delete on public.change_orders to authenticated;

-- Masking view — same pattern as projects_overview. Reads go through this;
-- writes (insert/update) still go straight to the base table, gated by the
-- row policies above.
create or replace view public.change_orders_overview
with (security_invoker = true)
as
select
  id, project_id, number, title, description, status,
  requested_by, requested_by_name, approved_by, approved_by_name, approved_at,
  created_at, updated_at,
  case when public.has_financial_access(project_id) then amount end as amount
from public.change_orders;

grant select on public.change_orders_overview to authenticated;

create or replace function public.set_change_orders_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.number is null then
    select coalesce(max(number), 0) + 1 into new.number from public.change_orders where project_id = new.project_id;
  end if;
  if new.requested_by is null then
    new.requested_by := public.current_staff_id();
  end if;
  return new;
end;
$$;

drop trigger if exists change_orders_set_defaults on public.change_orders;
create trigger change_orders_set_defaults
  before insert on public.change_orders
  for each row execute function public.set_change_orders_defaults();

create or replace function public.set_change_orders_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists change_orders_set_updated_at on public.change_orders;
create trigger change_orders_set_updated_at
  before update on public.change_orders
  for each row execute function public.set_change_orders_updated_at();

-- Keep projects.committed_amount in sync with approved change orders
-- (baseline contract_value + sum of approved change order amounts).
create or replace function public.recompute_project_committed_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
begin
  v_project_id := coalesce(new.project_id, old.project_id);
  update public.projects
  set committed_amount = coalesce((select contract_value from public.projects where id = v_project_id), 0)
    + coalesce((select sum(amount) from public.change_orders where project_id = v_project_id and status = 'approved'), 0)
  where id = v_project_id;
  return coalesce(new, old);
end;
$$;

drop trigger if exists change_orders_recompute_committed on public.change_orders;
create trigger change_orders_recompute_committed
  after insert or update or delete on public.change_orders
  for each row execute function public.recompute_project_committed_amount();


-- ============================================================================
-- 3. Submittals
-- ============================================================================

create table if not exists public.submittals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  number integer not null,
  title text not null,
  spec_section text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'approved_as_noted', 'revise_resubmit', 'rejected')),
  submitted_by uuid references public.staff_users(id),
  submitted_by_name text,
  reviewed_by uuid references public.staff_users(id),
  reviewed_by_name text,
  reviewed_at timestamptz,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);

create index if not exists submittals_project_id_idx on public.submittals (project_id);
create index if not exists submittals_status_idx on public.submittals (project_id, status);

alter table public.submittals enable row level security;

drop policy if exists "submittals_select_members" on public.submittals;
create policy "submittals_select_members"
  on public.submittals for select
  to authenticated
  using (public.is_project_member(project_id));

drop policy if exists "submittals_insert_members" on public.submittals;
create policy "submittals_insert_members"
  on public.submittals for insert
  to authenticated
  with check (public.is_project_member(project_id));

drop policy if exists "submittals_update_reviewers" on public.submittals;
create policy "submittals_update_reviewers"
  on public.submittals for update
  to authenticated
  using (public.project_role(project_id) in ('project_admin', 'project_manager'))
  with check (public.project_role(project_id) in ('project_admin', 'project_manager'));

drop policy if exists "submittals_delete_admins" on public.submittals;
create policy "submittals_delete_admins"
  on public.submittals for delete
  to authenticated
  using (public.project_role(project_id) = 'project_admin');

revoke all on public.submittals from anon;
grant select, insert, update, delete on public.submittals to authenticated;

create or replace function public.set_submittals_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.number is null then
    select coalesce(max(number), 0) + 1 into new.number from public.submittals where project_id = new.project_id;
  end if;
  if new.submitted_by is null then
    new.submitted_by := public.current_staff_id();
  end if;
  return new;
end;
$$;

drop trigger if exists submittals_set_defaults on public.submittals;
create trigger submittals_set_defaults
  before insert on public.submittals
  for each row execute function public.set_submittals_defaults();

create or replace function public.set_submittals_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists submittals_set_updated_at on public.submittals;
create trigger submittals_set_updated_at
  before update on public.submittals
  for each row execute function public.set_submittals_updated_at();


-- ============================================================================
-- 4. Project Events (Upcoming Events panel)
-- ============================================================================

create table if not exists public.project_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  event_date date not null,
  event_type text not null default 'other' check (event_type in ('milestone', 'meeting', 'inspection', 'other')),
  notes text,
  created_by uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_events_project_id_idx on public.project_events (project_id);
create index if not exists project_events_event_date_idx on public.project_events (project_id, event_date);

alter table public.project_events enable row level security;

drop policy if exists "project_events_select_members" on public.project_events;
create policy "project_events_select_members"
  on public.project_events for select
  to authenticated
  using (public.is_project_member(project_id));

drop policy if exists "project_events_write_leadership" on public.project_events;
create policy "project_events_write_leadership"
  on public.project_events for insert
  to authenticated
  with check (public.project_role(project_id) in ('project_admin', 'project_manager'));

drop policy if exists "project_events_update_leadership" on public.project_events;
create policy "project_events_update_leadership"
  on public.project_events for update
  to authenticated
  using (public.project_role(project_id) in ('project_admin', 'project_manager'))
  with check (public.project_role(project_id) in ('project_admin', 'project_manager'));

drop policy if exists "project_events_delete_leadership" on public.project_events;
create policy "project_events_delete_leadership"
  on public.project_events for delete
  to authenticated
  using (public.project_role(project_id) in ('project_admin', 'project_manager'));

revoke all on public.project_events from anon;
grant select, insert, update, delete on public.project_events to authenticated;

create or replace function public.set_project_events_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := public.current_staff_id();
  end if;
  return new;
end;
$$;

drop trigger if exists project_events_set_defaults on public.project_events;
create trigger project_events_set_defaults
  before insert on public.project_events
  for each row execute function public.set_project_events_defaults();

create or replace function public.set_project_events_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists project_events_set_updated_at on public.project_events;
create trigger project_events_set_updated_at
  before update on public.project_events
  for each row execute function public.set_project_events_updated_at();


-- ============================================================================
-- 5. Project Activity — append-only feed for the Recent Activity panel.
-- Same posture as audit_log (insert-only, no client update/delete), but
-- scoped and readable per-project instead of Super-Admin-only, since it's a
-- feature for everyone on the project rather than a security record.
-- Populated entirely by triggers, never by direct client inserts, so it
-- can't be skipped or spoofed by a page forgetting to log something.
-- ============================================================================

create table if not exists public.project_activity (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_id uuid references public.staff_users(id),
  actor_name text,
  verb text not null,
  entity_type text not null,
  entity_id uuid,
  summary text not null,
  created_at timestamptz not null default now()
);

create index if not exists project_activity_project_id_idx on public.project_activity (project_id, created_at desc);

alter table public.project_activity enable row level security;

drop policy if exists "project_activity_select_members" on public.project_activity;
create policy "project_activity_select_members"
  on public.project_activity for select
  to authenticated
  using (public.is_project_member(project_id));

-- Deliberately no insert/update/delete policy for `authenticated` — only
-- the SECURITY DEFINER helper below (called from triggers) can write here.
revoke all on public.project_activity from anon;
grant select on public.project_activity to authenticated;

create or replace function public.write_project_activity(
  p_project_id uuid, p_verb text, p_entity_type text, p_entity_id uuid, p_summary text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_staff_name text;
begin
  v_staff_id := public.current_staff_id();
  select full_name into v_staff_name from public.staff_users where id = v_staff_id;
  insert into public.project_activity (project_id, actor_id, actor_name, verb, entity_type, entity_id, summary)
  values (p_project_id, v_staff_id, v_staff_name, p_verb, p_entity_type, p_entity_id, p_summary);
end;
$$;

-- RFIs
create or replace function public.log_rfi_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_project_activity(new.project_id, 'created', 'rfi', new.id,
      format('RFI #%s opened: %s', new.number, new.subject));
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status and new.status = 'answered' then
    perform public.write_project_activity(new.project_id, 'answered', 'rfi', new.id,
      format('RFI #%s answered: %s', new.number, new.subject));
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status and new.status = 'closed' then
    perform public.write_project_activity(new.project_id, 'closed', 'rfi', new.id,
      format('RFI #%s closed: %s', new.number, new.subject));
  end if;
  return new;
end;
$$;

drop trigger if exists rfis_log_activity on public.rfis;
create trigger rfis_log_activity
  after insert or update on public.rfis
  for each row execute function public.log_rfi_activity();

-- Change orders
create or replace function public.log_change_order_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_project_activity(new.project_id, 'created', 'change_order', new.id,
      format('Change order #%s submitted: %s', new.number, new.title));
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status and new.status = 'approved' then
    perform public.write_project_activity(new.project_id, 'approved', 'change_order', new.id,
      format('Change order #%s approved: %s', new.number, new.title));
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status and new.status = 'rejected' then
    perform public.write_project_activity(new.project_id, 'rejected', 'change_order', new.id,
      format('Change order #%s rejected: %s', new.number, new.title));
  end if;
  return new;
end;
$$;

drop trigger if exists change_orders_log_activity on public.change_orders;
create trigger change_orders_log_activity
  after insert or update on public.change_orders
  for each row execute function public.log_change_order_activity();

-- Submittals
create or replace function public.log_submittal_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_project_activity(new.project_id, 'created', 'submittal', new.id,
      format('Submittal #%s created: %s', new.number, new.title));
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status and new.status <> 'pending' then
    perform public.write_project_activity(new.project_id, 'reviewed', 'submittal', new.id,
      format('Submittal #%s marked %s: %s', new.number, replace(new.status, '_', ' '), new.title));
  end if;
  return new;
end;
$$;

drop trigger if exists submittals_log_activity on public.submittals;
create trigger submittals_log_activity
  after insert or update on public.submittals
  for each row execute function public.log_submittal_activity();

-- Timeline items (phase/task completed)
create or replace function public.log_timeline_item_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.status is distinct from new.status and new.status = 'completed' then
    perform public.write_project_activity(new.project_id, 'completed', new.type, new.id,
      format('%s completed: %s', initcap(new.type), new.title));
  end if;
  return new;
end;
$$;

drop trigger if exists project_timeline_items_log_activity on public.project_timeline_items;
create trigger project_timeline_items_log_activity
  after update on public.project_timeline_items
  for each row execute function public.log_timeline_item_activity();

-- To-do checklist items (completed)
create or replace function public.log_todo_subitem_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.completed is distinct from new.completed and new.completed then
    perform public.write_project_activity(new.project_id, 'completed', 'todo_item', new.id,
      format('Checked off: %s', new.label));
  end if;
  return new;
end;
$$;

drop trigger if exists project_todo_subitems_log_activity on public.project_todo_subitems;
create trigger project_todo_subitems_log_activity
  after update on public.project_todo_subitems
  for each row execute function public.log_todo_subitem_activity();


-- ============================================================================
-- 6. Financial tracking columns on `projects`
-- ============================================================================

alter table public.projects
  add column if not exists committed_amount numeric,
  add column if not exists spent_to_date numeric;

-- Backfill committed_amount for existing projects (baseline = contract_value,
-- since there are no change orders yet for any of them).
update public.projects set committed_amount = contract_value where committed_amount is null;

-- Re-create projects_overview to mask the two new columns the same way as
-- contract_value. This is the full view definition from
-- supabase-rls-lockdown.sql with committed_amount/spent_to_date appended —
-- keep both files in sync if projects_overview's column list changes again.
create or replace view public.projects_overview
with (security_invoker = true)
as
select
  id, name, is_active, created_at, updated_at, created_by_id, created_by_name,
  owner_name, owner_phone, owner_email, owner_address,
  site_address, site_city, site_state, site_zip,
  gc_name, gc_phone, gc_email,
  poc_name, poc_role, poc_phone, poc_email,
  site_plans_status, site_plans_notes, site_plans_file_path,
  permit_number, permit_plans_status, permit_plans_notes, permit_plans_file_path,
  electric_provider, water_provider, other_utilities_notes,
  trash_vendor, porta_potty_vendor, temp_services_notes,
  county_city_office_name, county_city_contact_name, county_city_phone, county_city_email,
  status, project_manager_name, progress_percent, due_date,
  updated_by_id, updated_by_name, cover_photo_url,
  case when public.has_financial_access(id) then contract_value end as contract_value,
  case when public.has_financial_access(id) then electric_account_number end as electric_account_number,
  case when public.has_financial_access(id) then water_account_number end as water_account_number,
  case when public.has_financial_access(id) then trash_account_number end as trash_account_number,
  case when public.has_financial_access(id) then porta_potty_account_number end as porta_potty_account_number,
  case when public.has_financial_access(id) then committed_amount end as committed_amount,
  case when public.has_financial_access(id) then spent_to_date end as spent_to_date
from public.projects;

grant select on public.projects_overview to authenticated;


-- ============================================================================
-- 7. Close the RLS gap on tables that predate the security re-architecture.
-- These still had "to anon using (true)" policies — replaced with the same
-- is_project_member()-gated pattern as everything else.
-- ============================================================================

-- project_timeline_items
drop policy if exists "project_timeline_items_all_anon" on public.project_timeline_items;
drop policy if exists "project_timeline_items_select_members" on public.project_timeline_items;
drop policy if exists "project_timeline_items_write_members" on public.project_timeline_items;
drop policy if exists "project_timeline_items_update_members" on public.project_timeline_items;
drop policy if exists "project_timeline_items_delete_members" on public.project_timeline_items;

create policy "project_timeline_items_select_members"
  on public.project_timeline_items for select
  to authenticated
  using (public.is_project_member(project_id));

create policy "project_timeline_items_write_members"
  on public.project_timeline_items for insert
  to authenticated
  with check (public.is_project_member(project_id));

create policy "project_timeline_items_update_members"
  on public.project_timeline_items for update
  to authenticated
  using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));

create policy "project_timeline_items_delete_members"
  on public.project_timeline_items for delete
  to authenticated
  using (public.is_project_member(project_id));

revoke all on public.project_timeline_items from anon;
grant select, insert, update, delete on public.project_timeline_items to authenticated;

-- project_todo_items
drop policy if exists "project_todo_items_all_anon" on public.project_todo_items;
drop policy if exists "project_todo_items_select_members" on public.project_todo_items;
drop policy if exists "project_todo_items_write_members" on public.project_todo_items;
drop policy if exists "project_todo_items_update_members" on public.project_todo_items;
drop policy if exists "project_todo_items_delete_members" on public.project_todo_items;

create policy "project_todo_items_select_members"
  on public.project_todo_items for select
  to authenticated
  using (public.is_project_member(project_id));

create policy "project_todo_items_write_members"
  on public.project_todo_items for insert
  to authenticated
  with check (public.is_project_member(project_id));

create policy "project_todo_items_update_members"
  on public.project_todo_items for update
  to authenticated
  using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));

create policy "project_todo_items_delete_members"
  on public.project_todo_items for delete
  to authenticated
  using (public.is_project_member(project_id));

revoke all on public.project_todo_items from anon;
grant select, insert, update, delete on public.project_todo_items to authenticated;

-- project_todo_subitems
drop policy if exists "project_todo_subitems_all_anon" on public.project_todo_subitems;
drop policy if exists "project_todo_subitems_select_members" on public.project_todo_subitems;
drop policy if exists "project_todo_subitems_write_members" on public.project_todo_subitems;
drop policy if exists "project_todo_subitems_update_members" on public.project_todo_subitems;
drop policy if exists "project_todo_subitems_delete_members" on public.project_todo_subitems;

create policy "project_todo_subitems_select_members"
  on public.project_todo_subitems for select
  to authenticated
  using (public.is_project_member(project_id));

create policy "project_todo_subitems_write_members"
  on public.project_todo_subitems for insert
  to authenticated
  with check (public.is_project_member(project_id));

create policy "project_todo_subitems_update_members"
  on public.project_todo_subitems for update
  to authenticated
  using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));

create policy "project_todo_subitems_delete_members"
  on public.project_todo_subitems for delete
  to authenticated
  using (public.is_project_member(project_id));

revoke all on public.project_todo_subitems from anon;
grant select, insert, update, delete on public.project_todo_subitems to authenticated;


-- ============================================================================
-- Done. Sanity checks to run after this migration:
--   select count(*) from public.rfis;              -- 0 on a fresh install
--   select count(*) from public.project_activity;   -- 0 until something happens
--   select committed_amount, spent_to_date from public.projects limit 5;
--   select * from public.projects_overview limit 1; -- confirm it still returns rows
-- ============================================================================
