-- ============================================================================
-- Vendor Contacts (public."Contacts"): add the missing RLS policy so signed-in
-- staff can actually SEE the contacts they've saved (2026-08-28)
-- ============================================================================
--
-- Reported: "why are none of my contacts for each of the venders showing up?"
-- Every vendor's "View Contact Info" popup said "No contacts on file for this
-- company yet." even for vendors with real contacts entered.
--
-- Root cause, confirmed with Coleby directly in the Supabase dashboard rather
-- than guessed (this session only ever has the anon key and no network path
-- to the project, so the DB itself couldn't be inspected from here):
--   1. Table Editor -> Contacts shows real rows with real contact info, so
--      the data itself is fine and nothing is being lost on save.
--   2. The Contacts table has Row Level Security ENABLED.
--   3. This table has no create-table migration anywhere in sql/ -- it was
--      created directly in the Supabase dashboard at some point, which means
--      it was never touched by supabase-rls-lockdown.sql (grepped that file
--      directly; zero mentions of "Contacts") or any other migration in this
--      folder. It's the same class of gap already found and fixed three
--      times elsewhere in this app (generated_reports, notification_reads,
--      form_submissions update/delete) -- a table that predates, or was
--      simply never brought into, the app's real-Supabase-Auth RLS model.
--
-- With RLS on and no policy that actually matches the `authenticated` role,
-- Postgres doesn't error -- it just silently returns zero rows for any
-- authenticated request, which is indistinguishable in the app from "this
-- vendor genuinely has no contacts." That silent-empty behavior (not an
-- error banner) is exactly what Coleby saw, and it's what pointed at RLS
-- rather than a column-name mismatch (a wrong/missing column would have
-- thrown a real Postgres error and shown "Couldn't load contacts" instead).
--
-- Fix: add the same "for all to authenticated" policy already used for the
-- sibling public."Companies" table (Companies_authenticated, added in
-- supabase-rls-lockdown.sql) -- Contacts holds no more sensitive info than
-- Companies itself, and the app doesn't scope contacts by workgroup, so
-- there's no reason to gate this table any tighter than its parent record.
--
-- Safe to re-run.
-- ============================================================================

alter table public."Contacts" enable row level security;

drop policy if exists "Contacts_authenticated" on public."Contacts";

create policy "Contacts_authenticated"
  on public."Contacts"
  for all
  to authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on public."Contacts" to authenticated;
