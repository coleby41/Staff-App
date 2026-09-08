-- Adds a per-vendor "COI exemption" flag -- requested by Coleby (2026-09-08)
-- so a vendor that genuinely doesn't need a Certificate of Insurance can be
-- marked as such from the Add/Edit Vendor form (a new checkbox right after
-- the Tags section). When set, the app:
--   - hides the whole COI upload section on the Add/Edit Vendor form
--   - stops showing a COI badge on that vendor's card and list-view row
--   - stops showing a COI section in the read-only Vendor Profile popup
--   - treats the vendor as satisfying the "Valid COI" requirement for
--     Approved status (Status chip, popup, and the PDF reports, since they
--     all run through the same missingVendorRequirements()/isVendorApproved()
--     helpers in js/companies.js)
--   - is skipped by the daily send-coi-reminders digest
--
-- New column on public."Companies":
--   "COIExempt"  boolean  -- defaults to false; existing rows read as
--                             "not exempt" until someone checks the box.
--
-- Written defensively like sql/supabase-vendor-coi-setup.sql -- guarded by
-- a table-existence check, "add column if not exists" so it's safe to run
-- against whatever the live table actually looks like, and safe to re-run.
--
-- Run this once in the Supabase SQL Editor. No storage bucket or RLS
-- changes needed -- this is a plain boolean column on an already-open table.

do $$
begin
  if to_regclass('public."Companies"') is not null then
    execute 'alter table public."Companies" add column if not exists "COIExempt" boolean not null default false';
  end if;
end $$;
