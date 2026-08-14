-- ============================================================================
-- Form Builder — name-your-file on submit
--
-- Adds a nullable file_name column to form_submissions. Previously a
-- submission's PDF only ever got an internal, auto-generated storage path
-- (form_id/uuid.pdf) with no user-facing name anywhere. Now, when someone
-- hits Submit on a filled-out form (see the "Name this file" popup in
-- form-template.html / handleConfirmSubmissionFileName() in form-builder.js),
-- they're asked to name the file — that name is stored here and used as the
-- display name in the Responses list and as the actual filename when the
-- PDF is downloaded to their computer.
--
-- Existing rows (submitted before this feature existed) just have a null
-- file_name — the UI falls back to the form's title for those.
-- ============================================================================

alter table public.form_submissions
  add column if not exists file_name text;

comment on column public.form_submissions.file_name is
  'Display/download name the submitter chose for this submission''s PDF. Null for submissions made before this feature existed — UI falls back to form_title.';
