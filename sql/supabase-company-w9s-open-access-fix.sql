-- Loosens the "company-w9s" storage bucket's RLS policy so any
-- authenticated staff member can upload/read/replace/delete W9 files —
-- matching public."Companies"_authenticated (see
-- supabase-rls-lockdown.sql), which already lets every signed-in staff
-- member create/edit a vendor record and see/set its "SSN/FID" column.
--
-- Bug this fixes: the RLS lockdown pass restricted "company-w9s" to
-- Accounting/Office/Super Admin (public.has_payroll_access()), modeled
-- on the existing "Payroll Tools" access pattern. In practice this
-- silently broke "Add Vendor" for everyone else the moment a W9 file
-- was attached — companies.js (uploadW9(), called from
-- handleCompanyFormSubmit()) uploads the W9 to storage BEFORE it
-- inserts the vendor row, so the RLS rejection on the storage upload
-- ("new row violates row-level security policy") killed the whole save,
-- including the name/address fields that had nothing to do with the W9.
-- Since the vendor record itself was never gated this way, restricting
-- just the W9 file to a narrower group was an inconsistency, not an
-- intentional tighter boundary — confirmed with Coleby (2026-08-25).
--
-- Safe to re-run: drops the existing policy (if present) before
-- recreating it, and no-ops entirely if the bucket doesn't exist yet.
--
-- Run this once in the Supabase SQL Editor. The matching update has
-- also been made to the base supabase-rls-lockdown.sql so a future
-- fresh install gets this correct behavior from the start.

do $$
begin
  if exists (select 1 from storage.buckets where id = 'company-w9s') then
    execute 'drop policy if exists "company_w9s_bucket_anon_all" on storage.objects';
    execute 'drop policy if exists "company_w9s_authenticated" on storage.objects';
    execute $p$create policy "company_w9s_authenticated" on storage.objects for all to authenticated
      using (bucket_id = 'company-w9s')
      with check (bucket_id = 'company-w9s')$p$;
  end if;
end $$;
