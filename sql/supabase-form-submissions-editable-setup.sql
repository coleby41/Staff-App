-- ============================================================================
-- Form Builder — editable responses
--
-- Whoever can open a form's Responses list (the same manager-only gate as
-- the "Responses" button itself, enforced in the JS/UI layer — see
-- form-builder.js's canManageForms()) can now go back into an
-- already-submitted response and correct it, via a new "Edit" button next
-- to "View PDF".
--
-- form_submissions was originally insert + select only — "submissions are a
-- record, not something the app edits after the fact" (see the comment
-- above form_submissions_insert_anon in supabase-form-builder-setup.sql).
-- This migration deliberately supersedes that: it adds the missing update
-- policy, plus columns to track that an edit happened, without touching
-- submitted_by/submitted_by_name/created_at (those still describe who
-- originally filled it out, and when — an edit doesn't rewrite that).
-- ============================================================================

alter table public.form_submissions
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by uuid references public.staff_users(id),
  add column if not exists edited_by_name text;

comment on column public.form_submissions.edited_at is
  'When this submission''s answers were last edited after the original submit. Null if never edited.';
comment on column public.form_submissions.edited_by is
  'Staff member who last edited this submission''s answers.';
comment on column public.form_submissions.edited_by_name is
  'Snapshot of edited_by''s name at edit time, same convention as submitted_by_name.';

drop policy if exists "form_submissions_update_anon" on public.form_submissions;
create policy "form_submissions_update_anon"
  on public.form_submissions
  for update
  to anon
  using (true)
  with check (true);

-- No storage-policy change needed: the existing form_submissions_bucket_anon_all
-- policy (supabase-form-builder-setup.sql) already covers "for all" actions,
-- so overwriting a submission's PDF at its existing path (upsert: true, see
-- handleSubmitFillForm in form-builder.js) already works under it.
