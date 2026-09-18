-- Adds a free-text "Notes" field on vendors ("Companies") -- requested by
-- Coleby. Visible only in the read-only Vendor Profile popup (an
-- inline-editable textarea with its own "Save Notes" button, see
-- saveVendorNotes() in js/companies.js) -- deliberately NOT on the card
-- grid, NOT in the little Status/SSN/W9/COI rows inside a card, and NOT on
-- the Add/Edit Vendor form.
--
-- New column on public."Companies":
--   "Notes"  text  -- nullable, no default; existing rows read as "no notes"
--                      until someone adds one.
--
-- Written defensively like sql/supabase-vendor-coi-exemption-setup.sql --
-- guarded by a table-existence check, "add column if not exists" so it's
-- safe to run against whatever the live table actually looks like, and
-- safe to re-run.
--
-- Run this once in the Supabase SQL Editor. No storage bucket or RLS
-- changes needed -- this is a plain text column on an already-open table,
-- editable by anyone who can already open a vendor's profile (same access
-- as every other vendor field).

do $$
begin
  if to_regclass('public."Companies"') is not null then
    execute 'alter table public."Companies" add column if not exists "Notes" text';
  end if;
end $$;
