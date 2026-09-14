-- ============================================================================
-- supabase-incident-reports-setup.sql
--
-- New "Incident Report" form (pages/incident-report.html) + the approval
-- workflow behind it, surfaced on the new personal "Account Activity" page
-- (pages/account-activity.html). Adds:
--   1. projects.project_code — a short per-project code (e.g. "TP"), set
--      once from the New Project / Edit Project wizard, used to build this
--      project's incident report numbers (IR-TP-001, IR-TP-002, ...).
--   2. incident_report_counters — one atomic per-project counter, so two
--      approvals landing at the same moment can never hand out the same
--      number.
--   3. incident_report_settings — a single-row table holding the ONE
--      default approver for every incident report. Coleby: "I want to set
--      it one time and be done with it." Super Admin/IT set this once from
--      a button on pages/incident-report.html; it's never assigned or
--      reassigned per report. Created before incident_reports below since
--      that table's own insert trigger reads from it.
--   4. incident_reports — one row per submitted report, carrying the form
--      fields, the raw (pre-merge) attachments, and the approval workflow
--      state: who submitted it, who it's assigned to for approval (set
--      automatically at submission from #3 above), and the eventual
--      decision.
--   4a. incident_report_events — an append-only timeline log (submitted /
--      rejected / resubmitted / approved) behind the status timeline shown
--      on each report's card in Account Activity, plus a resubmission path
--      (rejected -> pending_approval, submitter-only) so a rejected report
--      gets edited and resubmitted in place rather than becoming a new row.
--   5. A trigger that enforces WHO is allowed to change WHAT on an
--      incident_reports row — namely, that a decision (approve/reject) can
--      only be made by whoever's currently assigned, that a resubmission
--      can only be made by the original submitter, and that nobody can
--      change who's assigned after the fact. Also: an AFTER DELETE trigger
--      that reclaims a deleted report's IR number (only when it held the
--      current top of its project's counter) and an RPC
--      (delete_incident_report_with_cleanup) letting the assigned approver
--      delete a report, filed PDF included.
--   6. project_files.bucket / project_files.source check constraints
--      widened to allow an approved incident report to file itself there
--      the same way a form submission already does.
--   7. A private storage bucket for the RAW attachments (PDFs + photos)
--      someone attaches when filing a report — kept separate from the
--      final merged PDF (which lands in the existing project-documents
--      bucket via project_files, same as everything else on the All Files
--      page).
--
-- PREREQUISITE: same as project_files — run this only after
-- supabase-auth-rearchitecture-schema.sql + supabase-rls-lockdown.sql +
-- supabase-project-files-schema.sql are already live. This file calls
-- current_staff_id(), is_workgroup(), is_super_admin() directly, and
-- alters public.project_files (must already exist).
--
-- Safe to run in one go — everything here is additive except the two
-- check-constraint widenings in section 6 (only ADD an allowed value) and
-- the status-column re-narrowing right after section 4's table/RLS block
-- (drops the now-unused 'pending_approver' state — see that comment if you
-- already have a test row sitting in it).
-- ============================================================================


-- ============================================================================
-- 1. projects.project_code
-- ============================================================================

alter table public.projects
  add column if not exists project_code text;

-- Case-insensitive uniqueness (so "tp" and "TP" can't collide) among
-- whichever projects actually have a code set — a project with none stays
-- fully unrestricted, since this column is optional until someone fills
-- it in from the wizard.
create unique index if not exists projects_project_code_uidx
  on public.projects (upper(project_code))
  where project_code is not null and project_code <> '';


-- ============================================================================
-- 2. incident_report_counters — one row per project, incremented atomically
-- by next_incident_report_number() below. Never written to directly.
-- ============================================================================

create table if not exists public.incident_report_counters (
  project_id uuid primary key references public.projects(id) on delete cascade,
  last_number integer not null default 0
);

alter table public.incident_report_counters enable row level security;
-- No policies for any client role on purpose — this table is only ever
-- touched through next_incident_report_number() (security definer, below),
-- never read or written directly by the app.
revoke all on public.incident_report_counters from anon, authenticated;

create or replace function public.next_incident_report_number(p_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  insert into public.incident_report_counters (project_id, last_number)
  values (p_project_id, 1)
  on conflict (project_id) do update
    set last_number = public.incident_report_counters.last_number + 1
  returning last_number into v_next;

  return v_next;
end;
$$;

-- Deliberately NOT granted to authenticated directly — only called from
-- inside finalize_incident_report_approval() below, which does its own
-- permission check first. Keeping this un-grantable means the only way to
-- consume a number is through that gated path.


-- ============================================================================
-- 3. incident_report_settings — a single row holding the ONE default
-- approver for every incident report. Coleby: "I want to set it one time
-- and be done with it" — replaces a per-report Assign/Reassign flow
-- entirely. Super Admin/IT set this once from a "Set Approver" button on
-- pages/incident-report.html; set_incident_report_defaults() (below, part
-- of section 4) reads it at submission time and stamps it onto the new
-- report. Changing it later only affects FUTURE submissions — a report
-- already in flight keeps the approver it was submitted with (see
-- enforce_incident_report_transitions(), also below, which blocks changing
-- assigned_approver_id on an existing row outright).
-- ============================================================================

create table if not exists public.incident_report_settings (
  id boolean primary key default true,
  constraint incident_report_settings_singleton check (id),
  default_approver_id uuid references public.staff_users(id),
  default_approver_name text,
  updated_by_id uuid references public.staff_users(id),
  updated_by_name text,
  updated_at timestamptz not null default now()
);

-- Seed the single row once. Every update after this is an UPDATE, never
-- another INSERT — there's intentionally no insert policy below.
insert into public.incident_report_settings (id)
values (true)
on conflict (id) do nothing;

alter table public.incident_report_settings enable row level security;

-- SELECT: any signed-in staff can read who the default approver is
-- (harmless to show, and the incident report form needs to know whether
-- one is set at all so it can block submission with a clear message when
-- it isn't).
drop policy if exists "incident_report_settings_select" on public.incident_report_settings;
create policy "incident_report_settings_select"
  on public.incident_report_settings for select
  to authenticated
  using (true);

-- UPDATE: Super Admin/IT only.
drop policy if exists "incident_report_settings_update" on public.incident_report_settings;
create policy "incident_report_settings_update"
  on public.incident_report_settings for update
  to authenticated
  using (public.is_workgroup('IT') or public.is_super_admin())
  with check (public.is_workgroup('IT') or public.is_super_admin());

revoke all on public.incident_report_settings from anon;
grant select, update on public.incident_report_settings to authenticated;

-- Stamps who changed it and when, and fills in default_approver_name from
-- staff_users so the client only ever has to send default_approver_id —
-- same "let the database derive the display name" approach used for
-- submitted_by_name etc. elsewhere in this file.
create or replace function public.stamp_incident_report_settings_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_by_id := public.current_staff_id();
  select full_name into new.updated_by_name from public.staff_users where id = new.updated_by_id;

  if new.default_approver_id is distinct from old.default_approver_id then
    select full_name into new.default_approver_name from public.staff_users where id = new.default_approver_id;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists incident_report_settings_stamp_update on public.incident_report_settings;
create trigger incident_report_settings_stamp_update
  before update on public.incident_report_settings
  for each row execute function public.stamp_incident_report_settings_update();


-- ============================================================================
-- 4. incident_reports
-- ============================================================================

create table if not exists public.incident_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  -- Form fields (see pages/incident-report.html)
  report_date date not null default current_date,
  price numeric(12, 2),
  buildings text,
  unit_numbers text,
  person_making_report text,
  reason_for_report text,
  who_caused_issue text,

  -- Raw (pre-merge) attachments kept in the incident-report-attachments
  -- bucket, same "keep the originals so it can be rebuilt" reasoning as
  -- form_submissions.attachments. Shape:
  -- [{"name": "photo1.jpg", "path": "<id>/attachments/0-photo1.jpg", "kind": "image"}, ...]
  attachments jsonb not null default '[]'::jsonb,

  -- Workflow state.
  --   pending_approval  — submitted; assigned_approver_id was set
  --                        automatically at insert time from the single
  --                        default approver in incident_report_settings
  --                        (see section 3 above), waiting on THEM
  --   approved / rejected — final
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected')),

  submitted_by uuid references public.staff_users(id),
  submitted_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  assigned_approver_id uuid references public.staff_users(id),
  assigned_approver_name text,
  assigned_by_id uuid references public.staff_users(id),
  assigned_by_name text,
  assigned_at timestamptz,

  decided_at timestamptz,
  decision_reason text,           -- required for a rejection, unused for an approval

  ir_number text,                 -- e.g. "IR-TP-001" — set only on approval
  project_file_id uuid references public.project_files(id) on delete set null
);

create index if not exists incident_reports_project_id_idx on public.incident_reports (project_id);
create index if not exists incident_reports_submitted_by_idx on public.incident_reports (submitted_by);
create index if not exists incident_reports_assigned_approver_idx on public.incident_reports (assigned_approver_id);
create index if not exists incident_reports_status_idx on public.incident_reports (status);

alter table public.incident_reports enable row level security;

-- SELECT: the submitter, whoever it's assigned to, or Super Admin/IT (who
-- can browse anyone's activity via the Account Activity page's staff
-- picker).
drop policy if exists "incident_reports_select" on public.incident_reports;
create policy "incident_reports_select"
  on public.incident_reports for select
  to authenticated
  using (
    submitted_by = public.current_staff_id()
    or assigned_approver_id = public.current_staff_id()
    or public.is_workgroup('IT')
    or public.is_super_admin()
  );

-- INSERT: open to any signed-in staff member for now (Coleby: "right now
-- just anyone, we'll work on this later") — narrow this `with check` to a
-- workgroup allowlist later without touching anything else.
drop policy if exists "incident_reports_insert" on public.incident_reports;
create policy "incident_reports_insert"
  on public.incident_reports for insert
  to authenticated
  with check (true);

-- UPDATE: left permissive at the RLS layer on purpose — the real
-- who-can-change-what rule (assign vs. decide) genuinely depends on which
-- columns are changing and what the row's CURRENT state is, which a single
-- USING/WITH CHECK pair can't express well. See the trigger below, which
-- is where that's actually enforced. Same "coarse RLS + a trigger for the
-- real business rule" split already used by project_files' own defaults
-- trigger.
drop policy if exists "incident_reports_update" on public.incident_reports;
create policy "incident_reports_update"
  on public.incident_reports for update
  to authenticated
  using (true)
  with check (true);

-- DELETE: Super Admin/IT only, for cleaning up a mistaken submission.
drop policy if exists "incident_reports_delete" on public.incident_reports;
create policy "incident_reports_delete"
  on public.incident_reports for delete
  to authenticated
  using (public.is_workgroup('IT') or public.is_super_admin());

revoke all on public.incident_reports from anon;
grant select, insert, update, delete on public.incident_reports to authenticated;

-- Defensive re-narrowing for anyone who already ran an earlier version of
-- this file with the old 4-state status column — 'pending_approver' has
-- been removed now that an approver is assigned automatically at
-- submission time (see section 3 above), not by a manual admin step. If
-- this fails because a test row is still sitting in 'pending_approver',
-- update or delete that row first, then re-run this file.
alter table public.incident_reports drop constraint if exists incident_reports_status_check;
alter table public.incident_reports
  add constraint incident_reports_status_check
  check (status in ('pending_approval', 'approved', 'rejected'));


-- ----------------------------------------------------------------------------
-- 4a. incident_report_events — an append-only audit log behind the status
-- timeline on each report's card in Account Activity ("Form Was Submitted
-- -> Form Was Rejected -> Form Was Resubmitted -> Form Was Approved").
-- Written only by log_incident_report_event() (security definer, below),
-- called from the triggers further down -- never inserted into directly by
-- the app, so there's no insert/update/delete policy for any client role.
-- ----------------------------------------------------------------------------

create table if not exists public.incident_report_events (
  id uuid primary key default gen_random_uuid(),
  incident_report_id uuid not null references public.incident_reports(id) on delete cascade,
  event_type text not null check (event_type in ('submitted', 'rejected', 'resubmitted', 'approved')),
  actor_id uuid references public.staff_users(id),
  actor_name text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists incident_report_events_report_id_idx on public.incident_report_events (incident_report_id);

alter table public.incident_report_events enable row level security;

-- SELECT: same audience as the report itself -- submitter, assigned
-- approver, or Super Admin/IT.
drop policy if exists "incident_report_events_select" on public.incident_report_events;
create policy "incident_report_events_select"
  on public.incident_report_events for select
  to authenticated
  using (
    exists (
      select 1 from public.incident_reports r
      where r.id = incident_report_events.incident_report_id
        and (r.submitted_by = public.current_staff_id()
             or r.assigned_approver_id = public.current_staff_id()
             or public.is_workgroup('IT')
             or public.is_super_admin())
    )
  );

revoke all on public.incident_report_events from anon, authenticated;
grant select on public.incident_report_events to authenticated;

create or replace function public.log_incident_report_event(p_report_id uuid, p_event_type text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := public.current_staff_id();
  v_actor_name text;
begin
  select full_name into v_actor_name from public.staff_users where id = v_actor_id;
  insert into public.incident_report_events (incident_report_id, event_type, actor_id, actor_name, note)
  values (p_report_id, p_event_type, v_actor_id, v_actor_name, p_note);
end;
$$;


-- ----------------------------------------------------------------------------
-- Defaults on insert: submitted_by/submitted_by_name, same pattern as
-- project_files.set_project_files_defaults(), PLUS the automatic approver
-- assignment. Coleby: "I want to set it one time and be done with it" —
-- rather than a manual Super Admin/IT "Assign Approver" step per report,
-- every new report is routed straight to whoever is set as the single
-- default approver in incident_report_settings (section 3 above) the
-- moment it's submitted. If nobody has set a default approver yet, the
-- insert is blocked with a clear error rather than silently creating an
-- orphaned report nobody will ever see.
-- ----------------------------------------------------------------------------

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
    where id = true;

  if v_approver_id is null then
    raise exception 'No default approver is set up for incident reports yet — a Super Admin or IT staff member needs to set one from the button on the Incident Report page before reports can be submitted.';
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

drop trigger if exists incident_reports_set_defaults on public.incident_reports;
create trigger incident_reports_set_defaults
  before insert on public.incident_reports
  for each row execute function public.set_incident_report_defaults();

-- Logs the "Form Was Submitted" timeline event. Has to be its own AFTER
-- INSERT trigger, separate from set_incident_report_defaults() above —
-- that one's a BEFORE INSERT trigger, and incident_report_events.incident_report_id
-- has a foreign key to incident_reports(id), which doesn't exist yet from
-- a BEFORE trigger's point of view (the row itself hasn't been written).
create or replace function public.log_incident_report_submitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.log_incident_report_event(new.id, 'submitted', null);
  return new;
end;
$$;

drop trigger if exists incident_reports_log_submitted on public.incident_reports;
create trigger incident_reports_log_submitted
  after insert on public.incident_reports
  for each row execute function public.log_incident_report_submitted();


-- ----------------------------------------------------------------------------
-- The real access-control rule for updates, split out of RLS and into a
-- trigger since it depends on which columns changed, not just who's asking:
--   - assigned_approver_id is set automatically at INSERT time (see
--     set_incident_report_defaults() above) from the single default
--     approver and is never changed per-report — Coleby: "I want to set it
--     one time and be done with it." Any attempt to change it on an
--     existing row is blocked outright, regardless of who's asking.
--   - Changing the STATUS to approved/rejected is only allowed by whoever
--     is currently assigned as the approver (or Super Admin as the
--     standing org-wide bypass used everywhere else in this app), and only
--     from pending_approval — a decision can't be made twice.
--   - Changing the STATUS from rejected back to pending_approval (a
--     resubmission — see pages/incident-report.html's edit mode) is only
--     allowed by the ORIGINAL SUBMITTER (or Super Admin), and clears the
--     old decision so the report reads as freshly waiting again; the old
--     rejection reason lives on in the timeline (incident_report_events),
--     not as a dangling decision_reason on the live row.
--   - Every one of those transitions also logs a timeline event — see
--     log_incident_report_event() above.
--   - Everything else (e.g. the one-time ir_number/project_file_id writes
--     that happen alongside an approval) is left alone here since it only
--     ever happens bundled with the transition above.
-- ----------------------------------------------------------------------------

create or replace function public.enforce_incident_report_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();

  if new.assigned_approver_id is distinct from old.assigned_approver_id then
    raise exception 'The approver is set automatically from the default approver setting and can''t be changed on an individual report.';
  end if;

  if new.status is distinct from old.status and new.status in ('approved', 'rejected') then
    if old.status <> 'pending_approval' then
      raise exception 'This report needs an assigned approver before it can be decided.';
    end if;
    if not (old.assigned_approver_id = public.current_staff_id() or public.is_super_admin()) then
      raise exception 'Only this report''s assigned approver can approve or reject it.';
    end if;
    new.decided_at := now();
    perform public.log_incident_report_event(new.id, new.status, case when new.status = 'rejected' then new.decision_reason else null end);
  end if;

  if new.status is distinct from old.status and new.status = 'pending_approval' then
    if old.status <> 'rejected' then
      raise exception 'This report can''t be resubmitted from its current status.';
    end if;
    if not (old.submitted_by = public.current_staff_id() or public.is_super_admin()) then
      raise exception 'Only this report''s original submitter can resubmit it.';
    end if;
    new.decision_reason := null;
    new.decided_at := null;
    perform public.log_incident_report_event(new.id, 'resubmitted', null);
  end if;

  return new;
end;
$$;

drop trigger if exists incident_reports_enforce_transitions on public.incident_reports;
create trigger incident_reports_enforce_transitions
  before update on public.incident_reports
  for each row execute function public.enforce_incident_report_transitions();


-- ----------------------------------------------------------------------------
-- Finalizes an approval: atomically grabs this project's next number,
-- builds the IR-<code>-### string, and stamps the row approved. Called by
-- the client FIRST (before building the merged PDF) — see
-- js/account-activity.js's approveIncidentReport(), which then builds and
-- files the PDF using the returned ir_number. If that later filing step
-- fails, the row is left "approved" with a real ir_number but no
-- project_file_id yet; the UI offers a "Retry filing" action for exactly
-- that case (it re-runs only the build/upload/file steps, never calls this
-- function again for the same report, so a number is never burned twice).
--
-- Returns the row so the client can read ir_number straight back without a
-- second round trip.
-- ----------------------------------------------------------------------------

create or replace function public.finalize_incident_report_approval(p_id uuid)
returns public.incident_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.incident_reports;
  v_code text;
  v_number integer;
begin
  select * into v_row from public.incident_reports where id = p_id for update;

  if v_row.id is null then
    raise exception 'Incident report not found.';
  end if;
  if v_row.status <> 'pending_approval' then
    raise exception 'This report isn''t waiting on a decision right now.';
  end if;
  if not (v_row.assigned_approver_id = public.current_staff_id() or public.is_super_admin()) then
    raise exception 'Only this report''s assigned approver can approve it.';
  end if;

  select project_code into v_code from public.projects where id = v_row.project_id;
  if v_code is null or v_code = '' then
    raise exception 'This project doesn''t have a Project Code set yet — add one from Edit Project before approving.';
  end if;

  v_number := public.next_incident_report_number(v_row.project_id);

  update public.incident_reports
    set status = 'approved',
        ir_number = 'IR-' || upper(v_code) || '-' || lpad(v_number::text, 3, '0'),
        decided_at = now(),
        updated_at = now()
    where id = p_id
    returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.finalize_incident_report_approval(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- Reclaims a deleted report's IR number so the next one submitted for that
-- project doesn't leave a gap — but ONLY when the deleted report held the
-- CURRENT top of that project's counter. If a newer report already has a
-- higher number, rolling the counter back would hand its number out again,
-- so the delete just leaves a gap in that case (same as deleting anything
-- else out of the middle of a sequence would).
-- ----------------------------------------------------------------------------

create or replace function public.reclaim_incident_report_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_number integer;
begin
  if old.ir_number is null then
    return old;
  end if;

  v_deleted_number := nullif(regexp_replace(old.ir_number, '^.*-(\d+)$', '\1'), old.ir_number)::integer;
  if v_deleted_number is null then
    return old;
  end if;

  update public.incident_report_counters
    set last_number = v_deleted_number - 1
    where project_id = old.project_id
      and last_number = v_deleted_number;

  return old;
end;
$$;

drop trigger if exists incident_reports_reclaim_number on public.incident_reports;
create trigger incident_reports_reclaim_number
  after delete on public.incident_reports
  for each row execute function public.reclaim_incident_report_number();


-- ----------------------------------------------------------------------------
-- Lets the report's assigned approver delete it (Coleby: "the person that
-- approves the form needs to be able to delete the form") — Super Admin/IT
-- already can via the plain incident_reports_delete RLS policy above; this
-- RPC is the approver's path, since RLS alone can't express "only the
-- approver assigned to THIS row" as cleanly as a trigger-style check. Also
-- cleans up the filed project_files row (if the report had already been
-- approved and filed) so a deleted report doesn't leave an orphaned PDF
-- behind in Project Files — the actual storage object is removed by the
-- client first (see js/account-activity.js's deleteReport()), since
-- Postgres itself can't reach into Supabase Storage.
-- ----------------------------------------------------------------------------

create or replace function public.delete_incident_report_with_cleanup(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.incident_reports;
begin
  select * into v_row from public.incident_reports where id = p_id for update;
  if v_row.id is null then
    raise exception 'Incident report not found.';
  end if;
  if not (v_row.assigned_approver_id = public.current_staff_id() or public.is_workgroup('IT') or public.is_super_admin()) then
    raise exception 'Only this report''s assigned approver can delete it.';
  end if;

  if v_row.project_file_id is not null then
    delete from public.project_files where id = v_row.project_file_id;
  end if;

  delete from public.incident_reports where id = p_id;
end;
$$;

grant execute on function public.delete_incident_report_with_cleanup(uuid) to authenticated;


-- ============================================================================
-- 5. project_files — widen the two check constraints so an approved
-- incident report can file itself there the same way a form submission
-- does (reuses the existing project-documents bucket, no new bucket
-- needed for the FINAL merged file — only the raw pre-merge attachments
-- get their own bucket, in section 6 below).
-- ============================================================================

alter table public.project_files drop constraint if exists project_files_bucket_check;
alter table public.project_files
  add constraint project_files_bucket_check
  check (bucket in ('project-documents', 'form-submissions'));
  -- (unchanged — the merged incident report PDF is filed into the existing
  -- 'project-documents' bucket, so no new bucket value is needed here)

alter table public.project_files drop constraint if exists project_files_source_check;
alter table public.project_files
  add constraint project_files_source_check
  check (source in ('upload', 'form_submission', 'incident_report'));

alter table public.project_files
  add column if not exists incident_report_id uuid references public.incident_reports(id) on delete set null;

create index if not exists project_files_incident_report_id_idx on public.project_files (incident_report_id);


-- ============================================================================
-- 6. Storage: private bucket for the RAW attachments (PDFs + photos)
-- someone attaches when filing a report. Same private/authenticated-only
-- policy shape as every other bucket in this app.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('incident-report-attachments', 'incident-report-attachments', false)
on conflict (id) do nothing;

drop policy if exists "incident_report_attachments_bucket_authenticated" on storage.objects;
create policy "incident_report_attachments_bucket_authenticated"
on storage.objects
for all
to authenticated
using (bucket_id = 'incident-report-attachments')
with check (bucket_id = 'incident-report-attachments');


-- ============================================================================
-- Done. Sanity checks to run after this migration:
--   select project_code from public.projects limit 5;                 -- new column, all null until set from the wizard
--   select count(*) from public.incident_reports;                     -- 0 on a fresh install
--   select * from public.incident_report_settings;                    -- one row, default_approver_id null until set from the form
--   select count(*) from public.incident_report_events;                -- 0 on a fresh install; grows one row per timeline event
--   select conname from pg_constraint where conrelid = 'public.project_files'::regclass; -- should show the two widened check constraints
--   select id, public from storage.buckets where id = 'incident-report-attachments'; -- public = false
--
-- Two things to do by hand afterward:
--   1. Open each active project's Edit Project wizard (Job Name step) and
--      set a Project Code — approving an incident report for a project
--      with no code set will fail with a clear error telling you to add
--      one, rather than silently numbering it wrong.
--   2. On the Incident Report page, a Super Admin or IT staff member needs
--      to click "Set Approver" and pick someone ONCE — until that's done,
--      nobody can submit a report (the insert is blocked with a clear
--      error rather than silently creating an unroutable one).
-- ============================================================================
