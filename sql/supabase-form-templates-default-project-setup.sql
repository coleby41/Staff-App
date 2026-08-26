-- ============================================================================
-- supabase-form-templates-default-project-setup.sql
--
-- Lets a form template be locked to one specific project, in addition to the
-- existing default_category/default_subfolder folder mapping added by
-- supabase-project-files-schema.sql.
--
-- Today, a "project form" (one with both default_category and
-- default_subfolder set) asks which project every time it's filled out
-- (or takes it from ?project= in the URL when opened from a project's All
-- Files page). That's still exactly right for a reusable template used
-- across many projects (e.g. a generic "Daily Report" form).
--
-- Some forms are only ever for ONE project though (e.g. a change-order form
-- built specifically for "123 Main St"), and asking the person filling it
-- out to pick from a project dropdown every single time is pure friction —
-- there's only ever one right answer. default_project_id lets the form's
-- creator answer that question once, at template-creation time, instead.
--
-- Nullable and fully backward compatible:
--   - null (the default): unchanged from today — if the template is
--     project-mapped, the person filling it out is asked which project (or
--     it's inferred from the URL/an existing submission being edited).
--   - set: the form is locked to that project. The project picker never
--     shows when filling it out; every submission files straight into that
--     project's folder. All the JS-side logic lives in form-builder.js —
--     this migration only adds the column that logic reads.
--
-- The existing file_form_submission() trigger in
-- supabase-project-files-schema.sql doesn't need any changes: it already
-- files strictly off form_submissions.project_id, which form-builder.js
-- populates from default_project_id (when set) exactly the same way it
-- already populates it from the URL or the project picker today.
--
-- on delete set null (not cascade): if the locked project is ever deleted,
-- the template survives — it just reverts to asking which project at
-- submission time, same as any other project-mapped form, rather than being
-- silently deleted itself.
--
-- Safe to re-run.
-- ============================================================================

alter table public.form_templates
  add column if not exists default_project_id uuid references public.projects(id) on delete set null;

comment on column public.form_templates.default_project_id is
  'Optional. When set, every submission of this form is locked to this project — no project picker shown when filling it out. Only meaningful when default_category/default_subfolder are also set; ignored for org-wide forms.';

-- ============================================================================
-- Sanity check to run after this migration:
--   select default_category, default_subfolder, default_project_id from public.form_templates limit 5;  -- new column, all null until a form is locked to a project
-- ============================================================================
