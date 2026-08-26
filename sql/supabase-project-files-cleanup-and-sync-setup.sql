-- ============================================================================
-- supabase-project-files-cleanup-and-sync-setup.sql
--
-- Two real gaps found while checking that project-mapped form submissions
-- can always be downloaded/previewed from All Files, and never show up
-- looking duplicated there:
--
-- 1. file_form_submission() (the trigger that files a project-mapped
--    submission into project_files — see supabase-project-files-schema.sql)
--    copied form_submissions.file_name into project_files.file_name
--    verbatim. That name is whatever the submitter typed in "Name this
--    file" — form-builder.js only started guaranteeing a real .pdf suffix
--    on it today (ensurePdfExtension() in handleConfirmSubmissionFileName()).
--    Every submission already on file before that JS change has a
--    file_name with no extension, and All Files' preview/download both key
--    off the extension (see project-files.js's getPreviewKind()) — so a
--    filed submission with no ".pdf" in its name silently fails to preview
--    ("Preview isn't available for this file type", even though it is a
--    PDF) and downloads with no file extension at all. Fixed going forward
--    at the trigger (so it's correct regardless of what any client sends,
--    not just today's form-builder.js) and backfilled for what's already
--    filed below.
--
-- 2. Deleting a response (the trash action in the Responses modal) removes
--    its files from storage and deletes the form_submissions row, but
--    nothing ever removed the matching project_files row — project_files
--    .form_submission_id just goes null (its FK is "on delete set null",
--    not cascade, deliberately, so a plain upload's project_files row is
--    never accidentally touched by this). The result: the All Files entry
--    for that response stays behind, now pointing at a storage object that
--    no longer exists (broken preview/download), and if the same form gets
--    filled out again for the same project, the new submission's own filed
--    copy is a second, separate row sitting right next to the stale one —
--    reads as a duplicated file even though only one of the two actually
--    works. Fixed with a matching "after delete" trigger, mirroring the
--    existing "after insert" one, so cleanup happens regardless of which
--    client (or which staff member's permissions) performed the delete.
--
-- Safe to re-run.
-- ============================================================================


-- ============================================================================
-- 1. file_form_submission() — normalize the file_name it writes, instead of
-- trusting whatever's on the row already.
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
  v_file_name text;
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

  v_file_name := coalesce(nullif(trim(new.file_name), ''), new.form_title, 'Form submission');
  if v_file_name !~* '\.pdf$' then
    v_file_name := v_file_name || '.pdf';
  end if;

  insert into public.project_files (
    project_id, category, subfolder, bucket, storage_path, file_name,
    source, form_submission_id, uploaded_by, uploaded_by_name
  ) values (
    new.project_id, v_category, v_subfolder, 'form-submissions', new.pdf_path,
    v_file_name,
    'form_submission', new.id, new.submitted_by, new.submitted_by_name
  );

  return new;
end;
$$;

-- Trigger itself is unchanged (still after-insert, still the same name) —
-- create or replace above is enough to pick up the new function body.


-- ============================================================================
-- 2. Clean up the matching project_files row(s) when a submission is
-- deleted, so All Files never keeps a broken leftover around and a
-- resubmission never looks like a duplicate of one. security definer, same
-- as the insert-side trigger, so this runs regardless of whether whoever
-- deleted the response also happens to hold project_files' own delete
-- permissions (uploader or project leadership) for that project.
-- ============================================================================

create or replace function public.unfile_form_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.project_files where form_submission_id = old.id;
  return old;
end;
$$;

drop trigger if exists form_submissions_unfile_on_delete on public.form_submissions;
create trigger form_submissions_unfile_on_delete
  after delete on public.form_submissions
  for each row execute function public.unfile_form_submission();


-- ============================================================================
-- 3. One-time backfill for what's already in the live database:
--   a. Add the missing .pdf suffix to any already-filed project_files row
--      (fixes preview/download for every submission filed before this
--      migration, without anyone having to re-save it).
--   b. Same fix on form_submissions.file_name itself, so the Responses
--      list and every download path there (already made resilient to a
--      missing suffix earlier today) show a consistent name too.
--   c. Remove any project_files row that's already an orphan from the
--      pre-fix delete behavior above — source='form_submission' with a
--      null form_submission_id can ONLY happen via that FK's "on delete
--      set null" firing (the insert trigger always sets it), so every row
--      matching this is unambiguously dead weight from a deleted response,
--      not a real file anyone still expects to open.
-- ============================================================================

update public.project_files
  set file_name = file_name || '.pdf'
  where source = 'form_submission'
    and file_name !~* '\.pdf$';

update public.form_submissions
  set file_name = file_name || '.pdf'
  where file_name is not null
    and file_name !~* '\.pdf$';

delete from public.project_files
  where source = 'form_submission'
    and form_submission_id is null;

-- ============================================================================
-- Sanity checks to run after this migration:
--   select file_name from public.project_files where source = 'form_submission' and file_name !~* '\.pdf$';  -- should return 0 rows
--   select count(*) from public.project_files where source = 'form_submission' and form_submission_id is null;  -- should be 0
-- ============================================================================
