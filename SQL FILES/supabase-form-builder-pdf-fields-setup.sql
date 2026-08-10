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
-- holds the filled-out output PDFs. Same anon-RLS pattern as the rest of
-- this project (no Supabase Auth — access control is app-level).
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('form-template-sources', 'form-template-sources', false)
on conflict (id) do nothing;

drop policy if exists "form_template_sources_bucket_anon_all" on storage.objects;
create policy "form_template_sources_bucket_anon_all"
on storage.objects
for all
to anon
using (bucket_id = 'form-template-sources')
with check (bucket_id = 'form-template-sources');
