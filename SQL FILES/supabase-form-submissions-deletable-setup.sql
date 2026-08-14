-- ============================================================================
-- Form Builder — deletable responses
--
-- Adds the missing delete policy for form_submissions. It was originally
-- insert + select only, then got an update policy when responses became
-- editable (see supabase-form-submissions-editable-setup.sql). This does
-- the same for delete, powering the new trash-can button in the Responses
-- modal (see openDeleteSubmissionConfirm()/confirmDeleteSubmission() in
-- form-builder.js).
--
-- Same access-control convention as the rest of this table: RLS is
-- permissive-to-anon, and the "only a manager can even open the Responses
-- modal" gate is enforced client-side (canManageForms() in form-builder.js),
-- same as it already is for View/Download/Edit.
--
-- No storage-policy change needed: the existing form_submissions_bucket_anon_all
-- policy (supabase-form-builder-setup.sql) already covers "for all" actions,
-- so removing a submission's PDF from storage already works under it.
-- ============================================================================

drop policy if exists "form_submissions_delete_anon" on public.form_submissions;
create policy "form_submissions_delete_anon"
  on public.form_submissions
  for delete
  to anon
  using (true);
