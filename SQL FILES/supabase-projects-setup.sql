-- ============================================================================
-- supabase-projects-setup.sql
--
-- Powers the new "Project Overview" page (project-home.html / projects-page.js)
-- and its "+ New Project Onboard" wizard popup. One row per project, filled in
-- by staff through a 10-step wizard covering: property owner contact info,
-- job name, job site address, general contractor, project point of contact,
-- site plans, permit plans, utilities account info, temporary trash/porta
-- potty vendors, and the county/city office contact. Every step is skippable
-- from the UI, so every column below is nullable — a project can be created
-- with just a name and nothing else, and filled in later by re-opening the
-- same wizard in edit mode.
--
-- Same conventions as the rest of this app: no Supabase Auth, so RLS is
-- permissive-to-anon with access control enforced client-side (this page is
-- gated by whichever workgroup Coleby assigns on the nav item).
--
-- `name` + `is_active` intentionally match the column names already assumed
-- by dashboard scripts/projects.js's "Project Snapshot" card (Active Projects
-- count), so that card starts working for real as soon as this migration runs
-- — no changes needed there.
--
-- Run this in Supabase → SQL Editor.
-- ============================================================================

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),

  -- Core / job name step
  name text,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_id text,
  created_by_name text,

  -- Step 1: Property owner contact info
  owner_name text,
  owner_phone text,
  owner_email text,
  owner_address text,

  -- Step 3: Job site address
  site_address text,
  site_city text,
  site_state text,
  site_zip text,

  -- Step 4: General contractor
  gc_name text,
  gc_phone text,
  gc_email text,

  -- Step 5: Project point of contact
  poc_name text,
  poc_role text,
  poc_phone text,
  poc_email text,

  -- Step 6: Site plans
  site_plans_status text,
  site_plans_notes text,
  site_plans_file_path text,

  -- Step 7: Permit plans
  permit_number text,
  permit_plans_status text,
  permit_plans_notes text,
  permit_plans_file_path text,

  -- Step 8: Utilities account info
  electric_provider text,
  electric_account_number text,
  water_provider text,
  water_account_number text,
  other_utilities_notes text,

  -- Step 9: Temporary trash / porta potties
  trash_vendor text,
  trash_account_number text,
  porta_potty_vendor text,
  porta_potty_account_number text,
  temp_services_notes text,

  -- Step 10: County / city office contact
  county_city_office_name text,
  county_city_contact_name text,
  county_city_phone text,
  county_city_email text
);

create index if not exists projects_is_active_idx on public.projects (is_active);

alter table public.projects enable row level security;

drop policy if exists "projects_all_anon" on public.projects;
create policy "projects_all_anon"
  on public.projects
  for all
  to anon
  using (true)
  with check (true);


-- ============================================================================
-- Storage: private bucket for the Site Plans / Permit Plans uploads in steps
-- 6 and 7. Signed URLs are generated on demand when someone clicks "View" —
-- same pattern as companies.js's W9 viewer / form-builder.js's submission PDFs.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('project-documents', 'project-documents', false)
on conflict (id) do nothing;

drop policy if exists "project_documents_bucket_anon_all" on storage.objects;
create policy "project_documents_bucket_anon_all"
on storage.objects
for all
to anon
using (bucket_id = 'project-documents')
with check (bucket_id = 'project-documents');


-- ============================================================================
-- Keep updated_at current on every edit (wizard "Save" in edit mode).
-- ============================================================================
create or replace function public.set_projects_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row
  execute function public.set_projects_updated_at();
