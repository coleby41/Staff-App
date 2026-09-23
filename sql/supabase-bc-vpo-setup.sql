-- ============================================================================
-- BC (Back Charge) / VPO — Phase 1
-- ============================================================================
-- Run once in the Supabase SQL Editor. Safe to re-run (every statement is
-- defensive: `if not exists` / `if not exists` column adds), same convention
-- as every other file in sql/.
--
-- Phase 1 scope: on approving an Incident Report, the approver is asked
-- "Is this a BC or a VPO?" — BC asks who to charge / who to credit, VPO
-- asks who the vendor is; everything else on both comes straight from the
-- IR. This file adds the tables that decision writes to, per-project
-- numbering, and template storage (project-specific + company default),
-- for both BC and VPO alike — both templates turned out to be nearly
-- identical in shape (same info table, same Building Number/Unit
-- Number/Amount line-items table), just tagged with their own {FIELD}
-- names ({ID_HERE}/{VPO_ID} etc.).
--
-- NOT in this file yet (Phase 2): the actual "fill the template and file
-- it into Project Files" step. back_charges.project_file_id and
-- vpos.project_file_id stay null until that ships — the records
-- themselves are created in full at approval time so nothing is lost
-- waiting on it.
-- ============================================================================


-- ============================================================================
-- 1. BC templates — one company-wide default (singleton) + one per project
-- ============================================================================

-- Singleton row, same pattern as incident_report_settings.
create table if not exists public.bc_default_template (
  id boolean primary key default true,
  storage_path text,
  file_name text,
  uploaded_by_id uuid references public.staff_users(id),
  uploaded_by_name text,
  updated_at timestamptz not null default now(),
  constraint bc_default_template_singleton check (id)
);

insert into public.bc_default_template (id) values (true)
  on conflict (id) do nothing;

create table if not exists public.bc_project_templates (
  project_id uuid primary key references public.projects(id) on delete cascade,
  storage_path text not null,
  file_name text,
  uploaded_by_id uuid references public.staff_users(id),
  uploaded_by_name text,
  uploaded_at timestamptz not null default now()
);

alter table public.bc_default_template enable row level security;
alter table public.bc_project_templates enable row level security;

drop policy if exists bc_default_template_select on public.bc_default_template;
create policy bc_default_template_select on public.bc_default_template for select using (true);
drop policy if exists bc_default_template_write on public.bc_default_template;
create policy bc_default_template_write on public.bc_default_template for all using (true) with check (true);

drop policy if exists bc_project_templates_select on public.bc_project_templates;
create policy bc_project_templates_select on public.bc_project_templates for select using (true);
drop policy if exists bc_project_templates_write on public.bc_project_templates;
create policy bc_project_templates_write on public.bc_project_templates for all using (true) with check (true);

-- Private bucket, same shape as incident-report-attachments. Coleby: create
-- this bucket in Supabase Storage (private) if it doesn't already exist —
-- this file doesn't create storage buckets, only tables.


-- ============================================================================
-- 1b. VPO templates — same shape as the BC template tables above.
-- ============================================================================

create table if not exists public.vpo_default_template (
  id boolean primary key default true,
  storage_path text,
  file_name text,
  uploaded_by_id uuid references public.staff_users(id),
  uploaded_by_name text,
  updated_at timestamptz not null default now(),
  constraint vpo_default_template_singleton check (id)
);

insert into public.vpo_default_template (id) values (true)
  on conflict (id) do nothing;

create table if not exists public.vpo_project_templates (
  project_id uuid primary key references public.projects(id) on delete cascade,
  storage_path text not null,
  file_name text,
  uploaded_by_id uuid references public.staff_users(id),
  uploaded_by_name text,
  uploaded_at timestamptz not null default now()
);

alter table public.vpo_default_template enable row level security;
alter table public.vpo_project_templates enable row level security;

drop policy if exists vpo_default_template_select on public.vpo_default_template;
create policy vpo_default_template_select on public.vpo_default_template for select using (true);
drop policy if exists vpo_default_template_write on public.vpo_default_template;
create policy vpo_default_template_write on public.vpo_default_template for all using (true) with check (true);

drop policy if exists vpo_project_templates_select on public.vpo_project_templates;
create policy vpo_project_templates_select on public.vpo_project_templates for select using (true);
drop policy if exists vpo_project_templates_write on public.vpo_project_templates;
create policy vpo_project_templates_write on public.vpo_project_templates for all using (true) with check (true);


-- ============================================================================
-- 2. Per-project BC numbering (BC-<project_code>-###, e.g. BC-HC-001)
-- ============================================================================

create table if not exists public.bc_counters (
  project_id uuid primary key references public.projects(id) on delete cascade,
  next_number integer not null default 1
);

alter table public.bc_counters enable row level security;
drop policy if exists bc_counters_all on public.bc_counters;
create policy bc_counters_all on public.bc_counters for all using (true) with check (true);

-- Atomic: locks the project's counter row, returns the number to use, and
-- leaves the counter incremented — same recipe as
-- next_incident_report_number() in supabase-incident-reports-setup.sql.
create or replace function public.next_bc_number(p_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number integer;
begin
  insert into public.bc_counters (project_id, next_number)
  values (p_project_id, 1)
  on conflict (project_id) do nothing;

  update public.bc_counters
     set next_number = next_number + 1
   where project_id = p_project_id
   returning next_number - 1 into v_number;

  return v_number;
end;
$$;


-- ============================================================================
-- 3. back_charges
-- ============================================================================

create table if not exists public.back_charges (
  id uuid primary key default gen_random_uuid(),
  incident_report_id uuid not null references public.incident_reports(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  -- Set once, on creation — e.g. "BC-HC-001".
  bc_number text,

  -- The only two fields that come from the approval popup, not the IR.
  -- Companies.id is bigint, not uuid (confirmed against the live schema --
  -- the first version of this migration guessed uuid, to match every other
  -- foreign key in this file, and Postgres refused it).
  vendor_to_charge_id bigint references public."Companies"(id),
  vendor_to_charge_name text,
  vendor_to_cr_back_id bigint references public."Companies"(id),
  vendor_to_cr_back_name text,

  -- Everything else is a snapshot of the incident report at the moment
  -- the BC was created, per Coleby: "all that info should come from the
  -- IR form except the to be charged and the credit". Snapshotted (not
  -- read live via a join) so the BC/template stay stable even if the IR
  -- or project record changes later.
  project_name text,
  report_date date,
  price numeric(12, 2),
  buildings text,
  unit_numbers text,
  person_making_report text,
  reason_for_report text,
  change_in_scope text,

  created_by_id uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),

  -- Which template was used to fill this BC — set at creation so a later
  -- change to the project's template doesn't retroactively change what an
  -- already-issued BC says it was built from.
  template_source text check (template_source in ('project', 'default')),
  template_storage_path text,

  -- Phase 2 fills these in once the template-fill + filing step exists.
  project_file_id uuid references public.project_files(id) on delete set null,
  filed_at timestamptz
);

create index if not exists back_charges_project_id_idx on public.back_charges (project_id);
create index if not exists back_charges_incident_report_id_idx on public.back_charges (incident_report_id);

alter table public.back_charges enable row level security;
drop policy if exists back_charges_all on public.back_charges;
create policy back_charges_all on public.back_charges for all using (true) with check (true);
-- Same "permissive RLS, app-level gating" convention as the rest of this
-- app (see supabase-incident-reports-setup.sql's own comments on this).
-- App-level: only someone with incident_reports.approve can create one,
-- since BC creation happens at the moment of approving the IR.


-- ============================================================================
-- 4. VPO numbering — VPO-<project_code>-<building>-<seq for that building>-
--    <total VPOs for the project, AS OF this VPO's creation>
-- ============================================================================
-- The trailing "total" segment is a snapshot at creation time, not a live
-- count — so VPO-HC-1-2-7 keeps reading "7" forever even after an 8th VPO
-- is created elsewhere in the project. Flagging this now: if you actually
-- want that last segment to always reflect the CURRENT project-wide total
-- (meaning older VPO IDs would need to be redisplayed, not just stored),
-- that's a different, bigger design — say so and this gets reworked before
-- Phase 2 VPO work starts.

create table if not exists public.vpo_building_counters (
  project_id uuid not null references public.projects(id) on delete cascade,
  building_number text not null,
  next_number integer not null default 1,
  primary key (project_id, building_number)
);

create table if not exists public.vpo_project_counters (
  project_id uuid primary key references public.projects(id) on delete cascade,
  total_count integer not null default 0
);

alter table public.vpo_building_counters enable row level security;
drop policy if exists vpo_building_counters_all on public.vpo_building_counters;
create policy vpo_building_counters_all on public.vpo_building_counters for all using (true) with check (true);

alter table public.vpo_project_counters enable row level security;
drop policy if exists vpo_project_counters_all on public.vpo_project_counters;
create policy vpo_project_counters_all on public.vpo_project_counters for all using (true) with check (true);

create or replace function public.next_vpo_numbering(p_project_id uuid, p_building_number text)
returns table (building_seq integer, project_total integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_building_seq integer;
  v_project_total integer;
begin
  insert into public.vpo_building_counters (project_id, building_number, next_number)
  values (p_project_id, p_building_number, 1)
  on conflict (project_id, building_number) do nothing;

  update public.vpo_building_counters
     set next_number = next_number + 1
   where project_id = p_project_id and building_number = p_building_number
   returning next_number - 1 into v_building_seq;

  insert into public.vpo_project_counters (project_id, total_count)
  values (p_project_id, 1)
  on conflict (project_id) do update set total_count = public.vpo_project_counters.total_count + 1
  returning total_count into v_project_total;

  building_seq := v_building_seq;
  project_total := v_project_total;
  return next;
end;
$$;


-- ============================================================================
-- 5. vpos
-- ============================================================================
-- Mirrors back_charges: a snapshot of the incident report at creation time,
-- plus the one field the VPO popup itself asks for (vendor — the
-- template's "Client Name" line). building_seq/project_total_at_creation
-- are the two numbers baked into vpo_number (see next_vpo_numbering()
-- above) — stored separately too so the UI/Form Log can show them without
-- re-parsing the formatted string.

create table if not exists public.vpos (
  id uuid primary key default gen_random_uuid(),
  incident_report_id uuid not null references public.incident_reports(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  vpo_number text,                    -- e.g. "VPO-HC-1-2-7"
  building_number text,               -- from the IR's (single-identifier) Buildings field
  building_seq integer,                -- the "2" in VPO-HC-1-2-7
  project_total_at_creation integer,   -- the "7" -- a snapshot, doesn't update retroactively (confirmed with Coleby)

  -- The only field the VPO popup itself asks for. Companies.id is bigint,
  -- not uuid -- see the same note on back_charges.vendor_to_charge_id above.
  vendor_id bigint references public."Companies"(id),
  vendor_name text,

  -- Everything else is a snapshot of the incident report, same pattern as
  -- back_charges.
  project_name text,
  report_date date,
  unit_numbers text,
  person_making_report text,
  reason_for_report text,
  change_in_scope text,
  price numeric(12, 2),

  created_by_id uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),

  template_source text check (template_source in ('project', 'default')),
  template_storage_path text,

  -- Phase 2 fills these in.
  project_file_id uuid references public.project_files(id) on delete set null,
  filed_at timestamptz
);

create index if not exists vpos_project_id_idx on public.vpos (project_id);
create index if not exists vpos_incident_report_id_idx on public.vpos (incident_report_id);

alter table public.vpos enable row level security;
drop policy if exists vpos_all on public.vpos;
create policy vpos_all on public.vpos for all using (true) with check (true);


-- ============================================================================
-- 6. incident_reports gets a record of the BC/VPO decision
-- ============================================================================
-- The "Is this a BC or a VPO?" popup now requires an answer -- BC, VPO, or
-- an explicit "doesn't need one" with a reason (Coleby: "it must be a VPO
-- or a BC ... if you want put a reject on there"). These columns are the
-- record of whichever of the three happened, so an approved report that
-- never got a BC/VPO shows up as a deliberate decision, not a silent gap.

alter table public.incident_reports add column if not exists bc_vpo_decision text;
alter table public.incident_reports drop constraint if exists incident_reports_bc_vpo_decision_check;
alter table public.incident_reports add constraint incident_reports_bc_vpo_decision_check
  check (bc_vpo_decision in ('bc', 'vpo', 'rejected'));
alter table public.incident_reports add column if not exists bc_vpo_decision_reason text;
alter table public.incident_reports add column if not exists bc_vpo_decision_at timestamptz;


-- ============================================================================
-- 7. Phase 2 — project_files gets back_charge_id/vpo_id, and 'source' widens
-- ============================================================================
-- The filled BC/VPO document files into project_files the same way an
-- incident report does (see js/bc-vpo-docs.js's fileFilledDocument()) --
-- these are the columns that link a filed file back to the back_charges/
-- vpos row it came from, and the constraint that lets 'source' say so.

alter table public.project_files add column if not exists back_charge_id uuid references public.back_charges(id) on delete set null;
alter table public.project_files add column if not exists vpo_id uuid references public.vpos(id) on delete set null;

create index if not exists project_files_back_charge_id_idx on public.project_files (back_charge_id);
create index if not exists project_files_vpo_id_idx on public.project_files (vpo_id);

alter table public.project_files drop constraint if exists project_files_source_check;
alter table public.project_files
  add constraint project_files_source_check
  check (source in ('upload', 'form_submission', 'incident_report', 'back_charge', 'vpo'));


-- ============================================================================
-- 8. Phase 2 — raw (pre-fill) template storage buckets
-- ============================================================================
-- Private buckets, same shape/policy as incident-report-attachments in
-- supabase-incident-reports-setup.sql. Only the RAW, pre-fill .docx
-- templates live here -- the FILLED BC/VPO documents go into the existing
-- project-documents bucket alongside every other filed document (already
-- covered by project_files_bucket_check's existing 'project-documents'
-- value, so nothing to widen there).

insert into storage.buckets (id, name, public)
values ('bc-templates', 'bc-templates', false)
on conflict (id) do nothing;

drop policy if exists "bc_templates_bucket_authenticated" on storage.objects;
create policy "bc_templates_bucket_authenticated"
on storage.objects
for all
to authenticated
using (bucket_id = 'bc-templates')
with check (bucket_id = 'bc-templates');

insert into storage.buckets (id, name, public)
values ('vpo-templates', 'vpo-templates', false)
on conflict (id) do nothing;

drop policy if exists "vpo_templates_bucket_authenticated" on storage.objects;
create policy "vpo_templates_bucket_authenticated"
on storage.objects
for all
to authenticated
using (bucket_id = 'vpo-templates')
with check (bucket_id = 'vpo-templates');


-- ============================================================================
-- 9. Phase 2, later -- 'bundled' template source
-- ============================================================================
-- Coleby: "it should use the default one that was given before ... dont
-- remake it jsut use the form" -- a BC/VPO with no project-specific and no
-- company-default template uploaded now falls back to a template shipped
-- with the app itself (assets/templates/*.docx, see js/bc-vpo-docs.js's
-- KIND.bundledPath) instead of failing with "no template uploaded". These
-- two constraints need widening to record that as a real template_source
-- value rather than the fill silently succeeding with a value the check
-- would have rejected.

alter table public.back_charges drop constraint if exists back_charges_template_source_check;
alter table public.back_charges
  add constraint back_charges_template_source_check
  check (template_source in ('project', 'default', 'bundled'));

alter table public.vpos drop constraint if exists vpos_template_source_check;
alter table public.vpos
  add constraint vpos_template_source_check
  check (template_source in ('project', 'default', 'bundled'));


-- ============================================================================
-- Done. Sanity checks to run after this migration:
--   select count(*) from public.back_charges;                          -- 0 on a fresh install
--   select count(*) from public.vpos;                                  -- 0 on a fresh install
--   select * from public.bc_default_template;                          -- one row, storage_path null until you upload a template
--   select * from public.vpo_default_template;                         -- one row, storage_path null until you upload a template
--   select conname from pg_constraint where conrelid = 'public.project_files'::regclass; -- should show project_files_source_check widened
--   select id, public from storage.buckets where id in ('bc-templates', 'vpo-templates'); -- both public = false
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conname in ('back_charges_template_source_check', 'vpos_template_source_check'); -- both should list 'bundled'
-- ============================================================================
