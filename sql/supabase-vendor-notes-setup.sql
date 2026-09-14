-- Adds a per-vendor free-text "Notes" field -- requested by Coleby
-- (2026-09-11): visible and editable from the Add/Edit Vendor form and the
-- read-only Vendor Profile popup (both opened from a vendor card), but
-- deliberately left off the vendor card itself and off the little
-- Status/SSN/W9/COI rows inside it -- notes are popup-only.
--
-- New column on public."Companies":
--   "Notes"  text  -- nullable; no notes yet on any existing row until
--                      someone fills one in.
--
-- Access: same as every other vendor field -- "access control is app-level"
-- (see the note at the top of js/companies.js and
-- sql/supabase-companies-setup.sql) since public."Companies" has no masking
-- view or column-level RLS. Notes is readable/writable by anyone who can
-- already open a vendor, same as Name/Street/SSN-FID/etc.
--
-- Written defensively like sql/supabase-vendor-coi-exemption-setup.sql --
-- guarded by a table-existence check, "add column if not exists" so it's
-- safe to run against whatever the live table actually looks like, and
-- safe to re-run.
--
-- Run this once in the Supabase SQL Editor. No storage bucket or RLS
-- changes needed -- this is a plain text column on an already-open table.

do $$
begin
  if to_regclass('public."Companies"') is not null then
    execute 'alter table public."Companies" add column if not exists "Notes" text';
  end if;
end $$;
