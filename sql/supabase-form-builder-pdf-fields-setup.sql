-- ============================================================================
-- Form Builder — PDF-based templates
--
-- Upgrades form_templates so a form can be built by uploading the actual PDF
-- of the form and placing fields directly on top of it (page + normalized
-- x/y/width/height, all 0..1 fractions of that page's size) instead of only
-- recreating it as generic questions from scratch.
--
-- Backwards compatible: existing rows have pdf_path = null and keep working
-- exactly as before through the legacy (non-PDF) builder/fill/submit code
-- path in form-builder.js. New forms created going forward are PDF-based.
--
-- fields jsonb now holds one of two field shapes depending on whether the
-- owning form_templates row has a pdf_path:
--
--   Legacy (pdf_path is null):
--     { "id": "field_ab12", "type": "short_text", "label": "Full name",
--       "required": true, "options": [] }
--
--   PDF-based (pdf_path is set):
--     { "id": "field_ab12", "type": "text", "label": "Full name",
--       "required": true, "options": [],
--       "page": 0, "x": 0.12, "y": 0.34, "width": 0.30, "height": 0.04 }
--     type is one of: text, number, date, checkbox, dropdown, signature
--     (dropdown carries "options"; the rest don't).
-- ============================================================================

alter table public.form_templates
  add column if not exists pdf_path text,
  add column if not exists page_count integer;

comment on column public.form_templates.pdf_path is
  'Path in the form-template-sources bucket to the uploaded source PDF. Null for legacy (non-PDF) forms.';
comment on column public.form_templates.page_count is
  'Number of pages in the uploaded source PDF. Null for legacy forms.';

-- ============================================================================
-- Storage: private bucket for the uploaded template PDFs (the source
-- documents forms are built from). Separate from form-submissions, which
-- holds the filled-out output PDFs.
--
-- 2026-08-26 update: this originally granted `anon` full access (matching
-- the pre-Supabase-Auth pattern the rest of the project used at the time).
-- That's since been superseded everywhere else by real per-session
-- `authenticated` policies (see supabase-rls-lockdown.sql and
-- supabase-close-unauthenticated-access-gaps.sql) — this bucket's policy
-- was simply never brought forward when that happened, which is exactly
-- why saving a PDF-based form template started failing with an RLS error
-- for real signed-in users (an `anon`-scoped policy doesn't apply to an
-- `authenticated` session at all). Writing the corrected, authenticated-only
-- version directly into this base file so a fresh install gets it right
-- from the start; supabase-close-unauthenticated-access-gaps.sql is what
-- actually fixes it on the already-deployed database.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('form-template-sources', 'form-template-sources', false)
on conflict (id) do nothing;

drop policy if exists "form_template_sources_bucket_anon_all" on storage.objects;
drop policy if exists "form_template_sources_bucket_authenticated" on storage.objects;
create policy "form_template_sources_bucket_authenticated"
on storage.objects
for all
to authenticated
using (bucket_id = 'form-template-sources')
with check (bucket_id = 'form-template-sources');
