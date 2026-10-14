-- ============================================================================
-- supabase-project-invoices-setup.sql
--
-- Project invoices (Accounting page → Invoices tab, and the phone camera
-- bubble's "Take / Upload project invoices").
--
--   1. project_files.source gains 'invoice', so an invoice's PDF shows in
--      Files → 07 Financial › Invoices but the Files page can tell it apart
--      (it blocks rename/delete there — invoices are managed on Accounting).
--   2. project_invoices: one row per invoice (vendor, number, total due,
--      invoice date, paid / not paid) pointing at its project_files row.
--   3. project_settings: per-project settings. First one is
--      invoice_manage_roles — which project roles may edit and delete
--      invoices (default Project Admin, Project Manager, Accounting).
--      Super Admin and IT can always.
--   4. can_manage_invoices(project_id): the same rule, enforced on
--      update/delete of project_invoices.
--
-- Viewing and adding invoices stays open to every signed-in staff member,
-- same as every other project table today
-- (supabase-flatten-project-permissions-to-all-staff.sql).
--
-- Safe to re-run. Run in Supabase → SQL Editor.
-- ============================================================================


-- 1. project_files: allow source = 'invoice' --------------------------------

-- Keeps every source already in use (incident_report, back_charge, vpo, and
-- anything else already stored) and adds 'invoice'.
do $$
declare
  allowed text;
begin
  select string_agg(quote_literal(v), ', ' order by v) into allowed
  from (
    select unnest(array['upload', 'form_submission', 'incident_report', 'back_charge', 'vpo', 'invoice']) as v
    union
    select distinct source from public.project_files where source is not null
  ) s;

  alter table public.project_files drop constraint if exists project_files_source_check;
  execute format(
    'alter table public.project_files add constraint project_files_source_check check (source in (%s))',
    allowed
  );
end $$;


-- 2. project_invoices ---------------------------------------------------------

create table if not exists public.project_invoices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  vendor_id text,                           -- public."Companies".id as text (kept loose: vendors can be deleted)
  vendor_name text not null,                -- name at the time it was saved (also used in the file name)
  invoice_number text not null,
  total_due numeric(12, 2) not null default 0,
  invoice_date date,
  paid boolean not null default false,
  project_file_id uuid references public.project_files(id) on delete set null,
  created_by uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hardware-store purchases (Home Depot, Lowe's …): no approved vendor —
-- vendor_name holds the store's name, plus a free-text description.
alter table public.project_invoices
  add column if not exists is_hardware_store boolean not null default false,
  add column if not exists description text;

create index if not exists project_invoices_project_id_idx on public.project_invoices (project_id);
create index if not exists project_invoices_project_file_id_idx on public.project_invoices (project_file_id);

alter table public.project_invoices enable row level security;


-- 3. project_settings ---------------------------------------------------------

create table if not exists public.project_settings (
  project_id uuid primary key references public.projects(id) on delete cascade,
  invoice_manage_roles text[] not null default array['project_admin', 'project_manager', 'accounting'],
  updated_at timestamptz not null default now()
);

alter table public.project_settings enable row level security;

drop policy if exists "project_settings_select_authenticated" on public.project_settings;
create policy "project_settings_select_authenticated"
  on public.project_settings for select to authenticated using (true);

-- Changing a project's settings: Super Admin, IT, or that project's Project
-- Admin (same people who can change its members).
drop policy if exists "project_settings_write_admins" on public.project_settings;
create policy "project_settings_write_admins"
  on public.project_settings for all to authenticated
  using (public.is_workgroup('IT') or public.project_role(project_id) = 'project_admin')
  with check (public.is_workgroup('IT') or public.project_role(project_id) = 'project_admin');

revoke all on public.project_settings from anon;
grant select, insert, update, delete on public.project_settings to authenticated;


-- 4. who can edit / delete invoices ------------------------------------------

create or replace function public.can_manage_invoices(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_workgroup('IT')          -- is_workgroup() is already true for Super Admin
    or coalesce(public.project_role(p_project_id), '') = any(
         coalesce(
           (select s.invoice_manage_roles from public.project_settings s where s.project_id = p_project_id),
           array['project_admin', 'project_manager', 'accounting']
         )
       );
$$;

grant execute on function public.can_manage_invoices(uuid) to authenticated;

drop policy if exists "project_invoices_select_authenticated" on public.project_invoices;
create policy "project_invoices_select_authenticated"
  on public.project_invoices for select to authenticated using (true);

drop policy if exists "project_invoices_insert_authenticated" on public.project_invoices;
create policy "project_invoices_insert_authenticated"
  on public.project_invoices for insert to authenticated with check (true);

drop policy if exists "project_invoices_update_managers" on public.project_invoices;
create policy "project_invoices_update_managers"
  on public.project_invoices for update to authenticated
  using (public.can_manage_invoices(project_id))
  with check (public.can_manage_invoices(project_id));

drop policy if exists "project_invoices_delete_managers" on public.project_invoices;
create policy "project_invoices_delete_managers"
  on public.project_invoices for delete to authenticated
  using (public.can_manage_invoices(project_id));

revoke all on public.project_invoices from anon;
grant select, insert, update, delete on public.project_invoices to authenticated;

create or replace function public.touch_project_invoices_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_invoices_touch_updated_at on public.project_invoices;
create trigger project_invoices_touch_updated_at
  before update on public.project_invoices
  for each row execute function public.touch_project_invoices_updated_at();
