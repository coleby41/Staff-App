-- ============================================================================
-- supabase-project-files-delete-sync-setup.sql
--
-- Closes the other direction of the same gap fixed in
-- supabase-project-files-cleanup-and-sync-setup.sql. That migration made
-- deleting a RESPONSE (the trash action in the Responses modal) also clean
-- up its entry in All Files. This migration is the mirror of it: deleting
-- a form-filed FILE from All Files (project-files.html's own Delete
-- action) removed the project_files row and the PDF from storage, but left
-- the form_submissions row completely untouched — so the response kept
-- showing in the form's own Responses list, now pointing at a pdf_path
-- that had just been deleted out from under it. "View PDF"/"Download" on
-- that leftover response would fail from that point on.
--
-- For a form-filed entry, All Files and the Responses list are two views
-- of the same real thing (one filled-out form) — deleting it from either
-- side should remove it from both, the same way it already does the other
-- direction. Fixed with an after-delete trigger on project_files that
-- removes the matching form_submissions row, mirroring
-- unfile_form_submission()'s own trigger on the other table. security
-- definer, same reasoning as that one: cleanup shouldn't depend on
-- whoever's deleting a file in All Files also happening to hold delete
-- rights on form_submissions.
--
-- No infinite-loop risk between the two triggers: this one deletes the
-- form_submissions row, which fires unfile_form_submission() (after
-- delete on form_submissions), which tries to delete project_files where
-- form_submission_id = that id — but the project_files row that triggered
-- all this is already gone (we're inside ITS OWN after-delete trigger), so
-- that second delete just matches zero rows and stops there.
--
-- Only fires for source = 'form_submission' rows with a real
-- form_submission_id — a plain manual upload in project_files never
-- touches form_submissions at all.
--
-- Safe to re-run.
-- ============================================================================

create or replace function public.delete_submission_on_file_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.source = 'form_submission' and old.form_submission_id is not null then
    delete from public.form_submissions where id = old.form_submission_id;
  end if;
  return old;
end;
$$;

drop trigger if exists project_files_delete_submission on public.project_files;
create trigger project_files_delete_submission
  after delete on public.project_files
  for each row execute function public.delete_submission_on_file_delete();

-- ============================================================================
-- Sanity check: delete a form-filed row from project_files (or use All
-- Files' own Delete action), then confirm its response is also gone from
-- that form's Responses list — not just from All Files.
-- ============================================================================
