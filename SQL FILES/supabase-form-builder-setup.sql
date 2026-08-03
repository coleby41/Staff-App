-- ============================================================================
-- Form Builder — lets IT/Super Admin/Office (or whoever created a given form)
-- build custom forms right in the app, and any signed-in staff member fill
-- them out. Powers the new form-template.html (form-builder.js).
--
-- Same conventions as the rest of this project: no Supabase Auth, so RLS is
-- permissive-to-anon with access control enforced in the JS/UI layer, not by
-- Postgres (see supabase-staff-documents-storage-policy-fix.sql for the same
-- pattern applied to storage).
-- ============================================================================

create table if not exists public.form_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text default '',
  -- Ordered array of field definitions, e.g.:
  -- [{ "id": "field_ab12", "type": "short_text", "label": "Full name",
  --    "help_text": "", "required": true, "options": [] }, ...]
  -- type is one of: short_text, paragraph, dropdown, checkboxes, radio,
  -- date, number, section (a section is a plain heading/divider, not an
  -- input — it's skipped for required/answer purposes).
  fields jsonb not null default '[]',
  created_by uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists form_templates_created_by_idx on public.form_templates (created_by);

alter table public.form_templates enable row level security;

drop policy if exists "form_templates_all_anon" on public.form_templates;
create policy "form_templates_all_anon"
  on public.form_templates
  for all
  to anon
  using (true)
  with check (true);


create table if not exists public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.form_templates(id) on delete cascade,
  -- Snapshot the title in case the form is renamed/deleted later.
  form_title text,
  submitted_by uuid references public.staff_users(id),
  submitted_by_name text,
  -- { "field_ab12": "Jane Smith", "field_cd34": ["Option A","Option B"] }
  answers jsonb not null default '{}',
  pdf_path text,
  created_at timestamptz not null default now()
);

create index if not exists form_submissions_form_id_idx on public.form_submissions (form_id);
create index if not exists form_submissions_submitted_by_idx on public.form_submissions (submitted_by);

alter table public.form_submissions enable row level security;

-- Insert + select only (no update/delete) — submissions are a record, not
-- something the app edits after the fact.
drop policy if exists "form_submissions_select_anon" on public.form_submissions;
create policy "form_submissions_select_anon"
  on public.form_submissions
  for select
  to anon
  using (true);

drop policy if exists "form_submissions_insert_anon" on public.form_submissions;
create policy "form_submissions_insert_anon"
  on public.form_submissions
  for insert
  to anon
  with check (true);


-- ============================================================================
-- Storage: private bucket for the generated submission PDFs. Signed URLs are
-- created on demand when someone actually opens one (see viewFormSubmission()
-- in form-builder.js) — same "generate the link when clicked, don't store a
-- long-lived one" pattern as companies.js's W9 viewer.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('form-submissions', 'form-submissions', false)
on conflict (id) do nothing;

drop policy if exists "form_submissions_bucket_anon_all" on storage.objects;
create policy "form_submissions_bucket_anon_all"
on storage.objects
for all
to anon
using (bucket_id = 'form-submissions')
with check (bucket_id = 'form-submissions');


-- ============================================================================
-- notifications: add an optional link so "Your form has been submitted —
-- View it here" can be a real clickable link instead of just text. Existing
-- rows/inserts are unaffected (both columns are nullable).
-- ============================================================================
alter table public.notifications
  add column if not exists link_url text;

alter table public.notifications
  add column if not exists link_label text;
