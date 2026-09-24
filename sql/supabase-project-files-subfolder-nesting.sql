-- ============================================================================
-- supabase-project-files-subfolder-nesting.sql
-- ============================================================================
-- Coleby: "how do i make this into a folder inside of a folder" — he wants
-- Contracts & Procurement / Back Charges - BC to itself contain two
-- folders, "BC Without Signature" and "BC With Signature" (see the new
-- `subfolders` array on the "back_charges" entry in
-- js/project-fields.js's PROJECT_FILE_CATEGORIES).
--
-- project_files only had two levels (category, subfolder) — this adds a
-- third, optional one. Nullable and 100% backward compatible: every
-- existing row, and every file filed under any subfolder that doesn't
-- declare its own `subfolders` in the taxonomy (the overwhelming majority),
-- keeps this null forever and is completely unaffected.
--
-- PREREQUISITE: run this only after supabase-project-files-schema.sql is
-- already live (this table must already exist).
--
-- Safe to re-run — both statements are defensive (`if not exists`).
-- ============================================================================

alter table public.project_files
  add column if not exists sub_subfolder text;

-- Matches the existing project_files_category_idx shape (project_id,
-- category, subfolder), extended one level — the folder view's file list
-- for a leaf folder always filters on all four columns together.
create index if not exists project_files_sub_subfolder_idx
  on public.project_files (project_id, category, subfolder, sub_subfolder);

-- ============================================================================
-- Done. Sanity check to run after this migration:
--   select column_name from information_schema.columns
--     where table_name = 'project_files' and column_name = 'sub_subfolder'; -- should return one row
-- ============================================================================
