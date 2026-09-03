-- Adds Certificate of Insurance (COI) tracking to vendors, alongside the
-- existing W9 support -- requested by Coleby (2026-09-02) to match a
-- mockup: vendor rows/cards get a COI status badge next to the existing
-- W9 one, and Add/Edit Vendor gets a COI upload + a real expiration date.
--
-- New columns on public."Companies":
--   "COIFilePath"   text      -- storage path in the "company-cois" bucket,
--                                same convention as "W9FilePath".
--   "COIExpiresOn"  date      -- the real expiration date Coleby asked to
--                                track, so the badge can flag an expired
--                                or soon-to-expire COI instead of just
--                                showing "on file / missing".
--   "W9UpdatedAt"   timestamptz -- when the current W9 file was uploaded.
--                                Added now (not asked for directly) purely
--                                so the existing W9 badge can show an
--                                "Updated <date>" line the same way the new
--                                COI badge shows "Expires <date>" -- set
--                                automatically by the app whenever a new W9
--                                file is uploaded, nothing for staff to
--                                fill in by hand.
--
-- Companies' schema isn't tracked anywhere else in this repo (see the
-- caveat in supabase-rls-lockdown.sql -- only "SSN/FID" and W9FilePath
-- were known from reading companies.js), so this is written defensively:
-- guarded by a table-existence check, and "add column if not exists" so
-- it's safe to run against whatever the live table actually looks like,
-- and safe to re-run.
--
-- Also creates the "company-cois" storage bucket (private, like
-- "company-w9s") if it doesn't already exist, and gives it the same
-- open-to-any-authenticated-staff-member policy as company-w9s and
-- workbooks -- see supabase-company-w9s-open-access-fix.sql and
-- supabase-workbooks-storage-policy-fix.sql for the identical pattern and
-- reasoning. Per Coleby's standing instruction, this does NOT add any
-- access restriction beyond "any authenticated staff member" -- COI
-- visibility matches W9 and SSN/FID, which are open to every signed-in
-- staff member today.
--
-- Run this once in the Supabase SQL Editor.

do $$
begin
  if to_regclass('public."Companies"') is not null then
    execute 'alter table public."Companies" add column if not exists "COIFilePath" text';
    execute 'alter table public."Companies" add column if not exists "COIExpiresOn" date';
    execute 'alter table public."Companies" add column if not exists "W9UpdatedAt" timestamptz';
  end if;
end $$;

-- Create the bucket if it doesn't exist yet (private, like company-w9s).
insert into storage.buckets (id, name, public)
select 'company-cois', 'company-cois', false
where not exists (select 1 from storage.buckets where id = 'company-cois');

do $$
begin
  if exists (select 1 from storage.buckets where id = 'company-cois') then
    execute 'drop policy if exists "company_cois_bucket_anon_all" on storage.objects';
    execute 'drop policy if exists "company_cois_authenticated" on storage.objects';
    execute $p$create policy "company_cois_authenticated" on storage.objects for all to authenticated
      using (bucket_id = 'company-cois')
      with check (bucket_id = 'company-cois')$p$;
  end if;
end $$;
