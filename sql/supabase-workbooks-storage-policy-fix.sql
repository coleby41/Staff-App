-- Fixes: "Workbook save failed: StorageApiError: new row violates row-level
-- security policy" when uploading a workbook (or its cover image) from
-- pages/excel-workbook.html.
--
-- The "workbooks" storage bucket has no setup file anywhere in this repo's
-- sql/ folder -- unlike every other bucket ("company-w9s",
-- "form-template-sources", etc.), which all got tracked migrations during
-- the RLS lockdown/Supabase Auth rearchitecture (see
-- supabase-rls-lockdown.sql, supabase-close-unauthenticated-access-gaps.sql,
-- supabase-company-w9s-open-access-fix.sql). That strongly suggests
-- "workbooks" was set up by hand in the dashboard at some earlier point and
-- simply never got carried forward into an `authenticated`-scoped policy
-- when the rest of the app moved off the old "anon key is enough" auth
-- model -- it either has no INSERT policy for `authenticated` at all, or
-- still has one written against a role/condition that no longer matches
-- how signed-in staff authenticate. Either way, the fix is the same one
-- already applied to "company-w9s" for the identical error message and
-- root cause (see supabase-company-w9s-open-access-fix.sql): give the
-- bucket a single permissive policy for every authenticated staff member,
-- matching how the "workbooks" table itself has no tighter access than
-- "any signed-in staff member" today (js/workbook-library.js gates
-- nothing by workgroup/role).
--
-- Covers uploads to BOTH the "covers/" and "files/" paths in this bucket
-- (workbook-library.js uses one bucket for both) -- this policy isn't
-- scoped by folder, so it doesn't matter which upload was failing.
--
-- Safe to re-run: drops the policy (under a couple of likely prior names)
-- if present before recreating it, and no-ops entirely if the bucket
-- doesn't exist yet.
--
-- Run this once in the Supabase SQL Editor.

do $$
begin
  if exists (select 1 from storage.buckets where id = 'workbooks') then
    execute 'drop policy if exists "workbooks_bucket_anon_all" on storage.objects';
    execute 'drop policy if exists "workbooks_authenticated" on storage.objects';
    execute $p$create policy "workbooks_authenticated" on storage.objects for all to authenticated
      using (bucket_id = 'workbooks')
      with check (bucket_id = 'workbooks')$p$;
  end if;
end $$;
