-- ============================================================================
-- supabase-project-files-schema.sql
--
-- "All Files" — a project-scoped folder taxonomy, populated by both plain
-- manual uploads AND form-template submissions filed automatically. Adds:
--   1. default_category/default_subfolder on form_templates (optional —
--      only templates meant to be filed per-project set these)
--   2. project_id on form_submissions (optional — org-wide forms like HR
--      forms stay null and are completely unaffected)
--   3. a new project_files table, which is the single index the All Files
--      page actually queries, whether a file got there by upload or by
--      form submission
--   4. a trigger that auto-files a form submission into project_files the
--      moment it's inserted with a project_id AND its template has a
--      folder mapping — no second client call required
--
-- PREREQUISITE: run this only after the full security re-architecture
-- (supabase-auth-rearchitecture-schema.sql + supabase-project-members-
-- backfill.sql + supabase-rls-lockdown.sql) is live. This file calls
-- current_staff_id(), is_project_member(), and project_role() directly.
--
-- Safe to run in one go — everything here is additive (new columns, new
-- table, new trigger). Nothing existing is dropped or narrowed.
-- ============================================================================


-- ============================================================================
-- 1. form_templates — optional fixed folder mapping.
-- A template with both columns set is a "project form": filling it out asks
-- which project (or takes it from ?project= in the URL) and auto-files the
-- result. A template with either column null behaves exactly as it does
-- today — org-wide, no project involved, no project_files row created.
-- ============================================================================

alter table public.form_templates
  add column if not exists default_category text,
  add column if not exists default_subfolder text;


-- ============================================================================
-- 2. form_submissions — optional project_id.
-- Nullable and backward compatible: every existing row, and every future
-- submission of a non-project-mapped template, keeps this null and is
-- completely unaffected by anything below.
-- ============================================================================

alter table public.form_submissions
  add column if not exists project_id uuid references public.projects(id) on delete cascade;

create index if not exists form_submissions_project_id_idx on public.form_submissions (project_id);


-- ============================================================================
-- 3. project_files — the index the All Files page queries.
-- ============================================================================

create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  category text not null,
  subfolder text not null,
  -- 'project-documents' for manual uploads (path: <project_id>/<category>/
  -- <subfolder>/<timestamp>-<filename>, same bucket/policy plain project
  -- documents already use); 'form-submissions' for filed form PDFs (path
  -- convention owned by form-builder.js, unrelated to this table).
  bucket text not null default 'project-documents' check (bucket in ('project-documents', 'form-submissions')),
  storage_path text not null,
  file_name text not null,
  source text not null default 'upload' check (source in ('upload', 'form_submission')),
  form_submission_id uuid references public.form_submissions(id) on delete set null,
  uploaded_by uuid references public.staff_users(id),
  uploaded_by_name text,
  created_at timestamptz not null default now()
);

create index if not exists project_files_project_id_idx on public.project_files (project_id);
create index if not exists project_files_category_idx on public.project_files (project_id, category, subfolder);
create index if not exists project_files_form_submission_id_idx on public.project_files (form_submission_id);

alter table public.project_files enable row level security;

create policy "project_files_select_authenticated"
  on public.project_files for select
  to authenticated
  using (true);
  -- 2026-08-31: widened from `using (public.is_project_member(project_id))`
  -- — every signed-in staff member can now see a project's files, not just
  -- its project_members rows. See
  -- supabase-open-project-access-to-all-staff.sql.

create policy "project_files_insert_authenticated"
  on public.project_files for insert
  to authenticated
  with check (true);

-- 2026-08-31: update/delete widened from "uploader or project leadership"
-- to any authenticated staff member — Coleby asked for everyone to have the
-- same permissions as everyone else. See
-- supabase-flatten-project-permissions-to-all-staff.sql.
create policy "project_files_update_authenticated"
  on public.project_files for update
  to authenticated
  using (true)
  with check (true);

create policy "project_files_delete_authenticated"
  on public.project_files for delete
  to authenticated
  using (true);

revoke all on public.project_files from anon;
grant select, insert, update, delete on public.project_files to authenticated;

create or replace function public.set_project_files_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.uploaded_by is null then
    new.uploaded_by := public.current_staff_id();
  end if;
  return new;
end;
$$;

drop trigger if exists project_files_set_defaults on public.project_files;
create trigger project_files_set_defaults
  before insert on public.project_files
  for each row execute function public.set_project_files_defaults();


-- ============================================================================
-- 4. Auto-file a form submission into project_files when it's for a project
-- AND its template has a folder mapping. Runs regardless of which client
-- code created the submission — form-builder.js only needs to write
-- project_id on the insert; the actual filing can't be forgotten later.
-- ============================================================================

create or replace function public.file_form_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category text;
  v_subfolder text;
begin
  if new.project_id is null then
    return new;
  end if;

  select default_category, default_subfolder
    into v_category, v_subfolder
    from public.form_templates
    where id = new.form_id;

  if v_category is null or v_subfolder is null then
    return new;
  end if;

  insert into public.project_files (
    project_id, category, subfolder, bucket, storage_path, file_name,
    source, form_submission_id, uploaded_by, uploaded_by_name
  ) values (
    new.project_id, v_category, v_subfolder, 'form-submissions', new.pdf_path,
    coalesce(new.file_name, new.form_title || '.pdf'),
    'form_submission', new.id, new.submitted_by, new.submitted_by_name
  );

  return new;
end;
$$;

drop trigger if exists form_submissions_file_on_insert on public.form_submissions;
create trigger form_submissions_file_on_insert
  after insert on public.form_submissions
  for each row execute function public.file_form_submission();

-- ============================================================================
-- Done. Sanity checks to run after this migration:
--   select count(*) from public.project_files;                    -- 0 on a fresh install
--   select default_category, default_subfolder from public.form_templates limit 5;  -- all null until you set one
--   select project_id from public.form_submissions limit 5;       -- all null until a project form is filled
-- ============================================================================
