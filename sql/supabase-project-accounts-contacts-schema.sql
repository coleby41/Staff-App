-- ============================================================================
-- supabase-project-accounts-contacts-schema.sql
--
-- Adds the data model behind the new "Accounts / Contacts" project page:
--   1. project_contacts          — people (Property Owner, General
--      Contractor, Project Point of Contact, Utilities, Trash/Porta
--      Potties, County/City Office, or a free-form "Other" contact).
--      Backs both the six quick-access cards and the "All Contacts" tab.
--   2. project_organizations     — companies/agencies tied to the project
--      (GC's company, a subcontractor, a vendor, a utility company, a
--      government agency, etc). Backs the "Organizations" tab. Separate
--      from the existing vendor/Companies system (companies.js) on
--      purpose — that's an org-wide vendor directory; this is a light,
--      project-scoped reference list, same relationship project_files has
--      to the org-wide document system.
--   3. project_utility_accounts  — individual utility accounts (electric,
--      water, gas, trash, internet, ...), each with a provider/account
--      number. Backs the "Utility Accounts" tab. Distinct from the
--      Utilities Account Info wizard step on Project Details (which is
--      just two fixed fields, electric + water) — this is an open-ended
--      list, so a project with 4 utility accounts isn't squeezed into 2.
--   4. project_gov_offices       — government/permitting offices (Building
--      Dept, Fire Marshal, Health Dept, ...) beyond the single County/City
--      Office wizard field. Backs the "Government / Offices" tab.
--
-- All four follow the same "uploader/creator or project leadership can
-- edit/delete, any project member can add" shape as project_files
-- (supabase-project-files-schema.sql) — see project_files_update_owner_or_
-- leadership for the precedent.
--
-- PREREQUISITE: run this only after the full security re-architecture is
-- live (supabase-auth-rearchitecture-schema.sql + supabase-project-
-- members-backfill.sql + supabase-rls-lockdown.sql). This file calls
-- current_staff_id(), is_project_member(), and project_role() directly.
--
-- Every `create policy` below is preceded by `drop policy if exists` —
-- learned the hard way on supabase-project-dashboard-schema.sql, where
-- skipping that made the file impossible to safely re-run after a partial
-- failure (see ROLLOUT-RUNBOOK.md / the project doc for that bug). Safe to
-- run this file more than once.
-- ============================================================================


-- ============================================================================
-- 1. project_contacts
-- ============================================================================

create table if not exists public.project_contacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  contact_type text not null default 'other' check (contact_type in (
    'property_owner', 'general_contractor', 'point_of_contact',
    'utilities', 'trash_porta_potties', 'county_city_office', 'other'
  )),
  full_name text not null,
  title text,
  company_name text,
  phone text,
  email text,
  notes text,
  created_by uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_contacts_project_id_idx on public.project_contacts (project_id);
create index if not exists project_contacts_type_idx on public.project_contacts (project_id, contact_type);

alter table public.project_contacts enable row level security;

drop policy if exists "project_contacts_select_members" on public.project_contacts;
drop policy if exists "project_contacts_select_authenticated" on public.project_contacts;
create policy "project_contacts_select_authenticated"
  on public.project_contacts for select
  to authenticated
  using (true);
  -- 2026-08-31: widened — see supabase-open-project-access-to-all-staff.sql.

drop policy if exists "project_contacts_insert_members" on public.project_contacts;
create policy "project_contacts_insert_authenticated"
  on public.project_contacts for insert
  to authenticated
  with check (true);

-- 2026-08-31: update/delete widened from "creator or project leadership" to
-- any authenticated staff member. See
-- supabase-flatten-project-permissions-to-all-staff.sql.
drop policy if exists "project_contacts_update_owner_or_leadership" on public.project_contacts;
create policy "project_contacts_update_authenticated"
  on public.project_contacts for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "project_contacts_delete_owner_or_leadership" on public.project_contacts;
create policy "project_contacts_delete_authenticated"
  on public.project_contacts for delete
  to authenticated
  using (true);

revoke all on public.project_contacts from anon;
grant select, insert, update, delete on public.project_contacts to authenticated;

create or replace function public.set_project_contacts_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := public.current_staff_id();
  end if;
  if new.created_by_name is null then
    select full_name into new.created_by_name from public.staff_users where id = new.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists project_contacts_set_defaults on public.project_contacts;
create trigger project_contacts_set_defaults
  before insert on public.project_contacts
  for each row execute function public.set_project_contacts_defaults();

create or replace function public.set_project_contacts_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists project_contacts_set_updated_at on public.project_contacts;
create trigger project_contacts_set_updated_at
  before update on public.project_contacts
  for each row execute function public.set_project_contacts_updated_at();


-- ============================================================================
-- 2. project_organizations
-- ============================================================================

create table if not exists public.project_organizations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  org_name text not null,
  org_type text not null default 'other' check (org_type in (
    'general_contractor', 'subcontractor', 'vendor', 'utility_company',
    'government_agency', 'insurance', 'other'
  )),
  phone text,
  email text,
  website text,
  address text,
  notes text,
  created_by uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_organizations_project_id_idx on public.project_organizations (project_id);

alter table public.project_organizations enable row level security;

drop policy if exists "project_organizations_select_members" on public.project_organizations;
drop policy if exists "project_organizations_select_authenticated" on public.project_organizations;
create policy "project_organizations_select_authenticated"
  on public.project_organizations for select
  to authenticated
  using (true);
  -- 2026-08-31: widened — see supabase-open-project-access-to-all-staff.sql.

drop policy if exists "project_organizations_insert_members" on public.project_organizations;
create policy "project_organizations_insert_authenticated"
  on public.project_organizations for insert
  to authenticated
  with check (true);

-- 2026-08-31: widened — see supabase-flatten-project-permissions-to-all-staff.sql.
drop policy if exists "project_organizations_update_owner_or_leadership" on public.project_organizations;
create policy "project_organizations_update_authenticated"
  on public.project_organizations for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "project_organizations_delete_owner_or_leadership" on public.project_organizations;
create policy "project_organizations_delete_authenticated"
  on public.project_organizations for delete
  to authenticated
  using (true);

revoke all on public.project_organizations from anon;
grant select, insert, update, delete on public.project_organizations to authenticated;

create or replace function public.set_project_organizations_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := public.current_staff_id();
  end if;
  if new.created_by_name is null then
    select full_name into new.created_by_name from public.staff_users where id = new.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists project_organizations_set_defaults on public.project_organizations;
create trigger project_organizations_set_defaults
  before insert on public.project_organizations
  for each row execute function public.set_project_organizations_defaults();

create or replace function public.set_project_organizations_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists project_organizations_set_updated_at on public.project_organizations;
create trigger project_organizations_set_updated_at
  before update on public.project_organizations
  for each row execute function public.set_project_organizations_updated_at();


-- ============================================================================
-- 3. project_utility_accounts
-- ============================================================================

create table if not exists public.project_utility_accounts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  utility_type text not null default 'other' check (utility_type in (
    'electric', 'water', 'gas', 'sewer', 'trash', 'internet', 'cable', 'other'
  )),
  provider_name text not null,
  account_number text,
  phone text,
  notes text,
  created_by uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_utility_accounts_project_id_idx on public.project_utility_accounts (project_id);

alter table public.project_utility_accounts enable row level security;

drop policy if exists "project_utility_accounts_select_members" on public.project_utility_accounts;
drop policy if exists "project_utility_accounts_select_authenticated" on public.project_utility_accounts;
create policy "project_utility_accounts_select_authenticated"
  on public.project_utility_accounts for select
  to authenticated
  using (true);
  -- 2026-08-31: widened — see supabase-open-project-access-to-all-staff.sql.

drop policy if exists "project_utility_accounts_insert_members" on public.project_utility_accounts;
create policy "project_utility_accounts_insert_authenticated"
  on public.project_utility_accounts for insert
  to authenticated
  with check (true);

-- 2026-08-31: widened — see supabase-flatten-project-permissions-to-all-staff.sql.
drop policy if exists "project_utility_accounts_update_owner_or_leadership" on public.project_utility_accounts;
create policy "project_utility_accounts_update_authenticated"
  on public.project_utility_accounts for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "project_utility_accounts_delete_owner_or_leadership" on public.project_utility_accounts;
create policy "project_utility_accounts_delete_authenticated"
  on public.project_utility_accounts for delete
  to authenticated
  using (true);

revoke all on public.project_utility_accounts from anon;
grant select, insert, update, delete on public.project_utility_accounts to authenticated;

create or replace function public.set_project_utility_accounts_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := public.current_staff_id();
  end if;
  if new.created_by_name is null then
    select full_name into new.created_by_name from public.staff_users where id = new.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists project_utility_accounts_set_defaults on public.project_utility_accounts;
create trigger project_utility_accounts_set_defaults
  before insert on public.project_utility_accounts
  for each row execute function public.set_project_utility_accounts_defaults();

create or replace function public.set_project_utility_accounts_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists project_utility_accounts_set_updated_at on public.project_utility_accounts;
create trigger project_utility_accounts_set_updated_at
  before update on public.project_utility_accounts
  for each row execute function public.set_project_utility_accounts_updated_at();


-- ============================================================================
-- 4. project_gov_offices
-- ============================================================================

create table if not exists public.project_gov_offices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  office_name text not null,
  department text,
  jurisdiction text,
  contact_name text,
  phone text,
  email text,
  address text,
  notes text,
  created_by uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_gov_offices_project_id_idx on public.project_gov_offices (project_id);

alter table public.project_gov_offices enable row level security;

drop policy if exists "project_gov_offices_select_members" on public.project_gov_offices;
drop policy if exists "project_gov_offices_select_authenticated" on public.project_gov_offices;
create policy "project_gov_offices_select_authenticated"
  on public.project_gov_offices for select
  to authenticated
  using (true);
  -- 2026-08-31: widened — see supabase-open-project-access-to-all-staff.sql.

drop policy if exists "project_gov_offices_insert_members" on public.project_gov_offices;
create policy "project_gov_offices_insert_authenticated"
  on public.project_gov_offices for insert
  to authenticated
  with check (true);

-- 2026-08-31: widened — see supabase-flatten-project-permissions-to-all-staff.sql.
drop policy if exists "project_gov_offices_update_owner_or_leadership" on public.project_gov_offices;
create policy "project_gov_offices_update_authenticated"
  on public.project_gov_offices for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "project_gov_offices_delete_owner_or_leadership" on public.project_gov_offices;
create policy "project_gov_offices_delete_authenticated"
  on public.project_gov_offices for delete
  to authenticated
  using (true);

revoke all on public.project_gov_offices from anon;
grant select, insert, update, delete on public.project_gov_offices to authenticated;

create or replace function public.set_project_gov_offices_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := public.current_staff_id();
  end if;
  if new.created_by_name is null then
    select full_name into new.created_by_name from public.staff_users where id = new.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists project_gov_offices_set_defaults on public.project_gov_offices;
create trigger project_gov_offices_set_defaults
  before insert on public.project_gov_offices
  for each row execute function public.set_project_gov_offices_defaults();

create or replace function public.set_project_gov_offices_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists project_gov_offices_set_updated_at on public.project_gov_offices;
create trigger project_gov_offices_set_updated_at
  before update on public.project_gov_offices
  for each row execute function public.set_project_gov_offices_updated_at();


-- ============================================================================
-- Done. Sanity checks to run after this migration:
--   select count(*) from public.project_contacts;           -- 0 on a fresh install
--   select count(*) from public.project_organizations;      -- 0 on a fresh install
--   select count(*) from public.project_utility_accounts;   -- 0 on a fresh install
--   select count(*) from public.project_gov_offices;        -- 0 on a fresh install
-- ============================================================================
