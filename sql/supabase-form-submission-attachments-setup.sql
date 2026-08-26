-- ============================================================================
-- supabase-form-submission-attachments-setup.sql
--
-- Lets a form's creator turn on an "Attach files" section for that one
-- form (off by default — most forms don't need it). When on, the person
-- filling it out can attach supporting PDFs, drag them into order, and
-- those pages get merged onto the end of the submission's own generated
-- PDF at submit time. One output file per submission — the form's own
-- pages first, then each attachment's pages in the order they were
-- arranged. All of the merge logic lives in form-builder.js
-- (mergeSubmissionAttachments()); this migration only adds the columns it
-- reads and writes.
--
-- Word docs are NOT supported here — there's no way to convert a .docx
-- into PDF pages client-side without a server-side/API conversion step,
-- so this feature is PDF-only by design.
-- ============================================================================

-- 1. form_templates.allow_attachments — the per-form toggle, set in the
-- Add/Edit Form builder. Nullable-safe default false: every existing form
-- keeps behaving exactly as it does today until someone explicitly turns
-- this on for it.
alter table public.form_templates
  add column if not exists allow_attachments boolean not null default false;

comment on column public.form_templates.allow_attachments is
  'Optional. When true, the fill-out form shows an "Attach files" section letting the submitter add PDFs (reordered by drag) that get merged onto the end of this submission''s own generated PDF.';

-- 2. form_submissions.attachments — ordered metadata for the ORIGINAL
-- attachment PDFs, kept separately in storage from pdf_path (which is
-- always the fresh merged output). Keeping the originals around is what
-- lets a submission's attachments be re-merged (added to, removed from,
-- reordered) when the response is edited later, without needing the
-- person to re-upload files they already attached once.
--
-- Shape: [{"name": "invoice.pdf", "path": "<formId>/<submissionId>/attachments/0-invoice.pdf"}, ...]
alter table public.form_submissions
  add column if not exists attachments jsonb not null default '[]'::jsonb;

comment on column public.form_submissions.attachments is
  'Ordered array of the original attachment PDFs kept in storage for this submission (see form_templates.allow_attachments). Empty for every submission made before this feature existed, and for any form that never turned it on.';

-- No storage-policy change needed for the attachments themselves — they're
-- uploaded into the same private form-submissions bucket, under a nested
-- "<formId>/<submissionId>/attachments/" path, and the bucket's existing
-- policy (see below) is scoped only by bucket_id, not by path shape.


-- ============================================================================
-- Found while building this feature, unrelated to it but directly
-- adjacent: form_submissions has never had an UPDATE or DELETE policy for
-- the `authenticated` role. supabase-rls-lockdown.sql (the pass that moved
-- this table off permissive-to-anon access) only created
-- form_submissions_select_authenticated / _insert_authenticated —
-- the original _update_anon / _delete_anon policies from
-- supabase-form-submissions-editable-setup.sql / -deletable-setup.sql are
-- scoped `to anon` and simply don't apply to a real logged-in session.
--
-- That means Edit response and Delete response (the pencil/trash actions
-- in the Responses list, and now this migration's own "edit a response's
-- attachments" path) have likely been silently failing with an RLS
-- violation against the live database this whole time, for every signed-in
-- user — nothing about the client-side "only a manager can open Responses"
-- gate changes that; it's a database-level block, not a UI one.
--
-- Adding the missing authenticated policies here, same shape/naming as
-- their anon-era predecessors and the same `to authenticated` convention
-- already used for select/insert on this table.
-- ============================================================================

drop policy if exists "form_submissions_update_authenticated" on public.form_submissions;
create policy "form_submissions_update_authenticated"
  on public.form_submissions for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "form_submissions_delete_authenticated" on public.form_submissions;
create policy "form_submissions_delete_authenticated"
  on public.form_submissions for delete
  to authenticated
  using (true);

grant update, delete on public.form_submissions to authenticated;

-- ============================================================================
-- Sanity checks to run after this migration:
--   select allow_attachments from public.form_templates limit 5;   -- new column, all false until a form turns it on
--   select attachments from public.form_submissions limit 5;       -- new column, all '[]' until a submission has one
--   select polname, cmd, roles from pg_policies where tablename = 'form_submissions';  -- should now show update/delete rows for {authenticated}
-- ============================================================================
