-- Closes three RLS/storage gaps found during a security review (2026-08-25)
-- that let someone with NO login at all -- just the public anon key, which
-- is inherently exposed in the client bundle by design and is not itself a
-- bug -- read and/or write real data. All three predate the Supabase Auth
-- rearchitecture and were simply never revisited when supabase-rls-lockdown.sql
-- tightened everything else; see the security-audit doc for the full writeup.
--
-- Safe to re-run.
--
-- 2026-08-26 note: item 3 below (form-template-sources) is the direct fix
-- for "Failed to save form: StorageApiError: new row violates row-level
-- security policy" when uploading a PDF-based form template -- that error
-- means this migration hasn't been run against the live database yet. The
-- old anon-only storage policy simply doesn't apply to a real signed-in
-- (authenticated) session, so every authenticated upload to that bucket is
-- rejected until this file replaces it with the authenticated-scoped one.

-- ============================================================================
-- 1. generated_reports -- "for all using (true) with check (true)" with NO
--    "to" clause, which defaults to the PUBLIC pseudo-role. Combined with
--    Supabase's default table grants (anon/authenticated get full privileges
--    on new public-schema tables unless explicitly revoked -- every other
--    table in this project does that revoke; this file never did), anyone
--    could select/insert/update/delete every row with just the anon key --
--    no session required. Tightened to match the "insert+select only,
--    authenticated" pattern already used for form_submissions.
-- ============================================================================

drop policy if exists "Allow all access to generated_reports" on public.generated_reports;
drop policy if exists "generated_reports_authenticated" on public.generated_reports;

create policy "generated_reports_authenticated"
  on public.generated_reports for select
  to authenticated
  using (true);

create policy "generated_reports_insert_authenticated"
  on public.generated_reports for insert
  to authenticated
  with check (true);

revoke all on public.generated_reports from anon;
revoke all on public.generated_reports from public;
grant select, insert on public.generated_reports to authenticated;


-- ============================================================================
-- 2. notification_reads -- written before the Supabase Auth migration
--    ("there's no Supabase Auth, so auth.uid() is always null... staff_user_id
--    is trusted from the client"). Anyone with the anon key -- no login --
--    could read every staff member's read-receipts (who read which
--    notification, and when) and insert rows claiming to be any staff_user_id
--    they choose. Rewritten to require a real session and to only let that
--    session write/read receipts tied to ITS OWN staff_users row, via
--    auth_user_id (the same column auth-guard.js already checks).
-- ============================================================================

drop policy if exists "notification_reads_select_anon" on public.notification_reads;
drop policy if exists "notification_reads_insert_anon" on public.notification_reads;
drop policy if exists "notification_reads_select_own" on public.notification_reads;
drop policy if exists "notification_reads_insert_own" on public.notification_reads;

create policy "notification_reads_select_own"
  on public.notification_reads for select
  to authenticated
  using (
    staff_user_id in (
      select id from public.staff_users where auth_user_id = auth.uid()
    )
  );

create policy "notification_reads_insert_own"
  on public.notification_reads for insert
  to authenticated
  with check (
    staff_user_id in (
      select id from public.staff_users where auth_user_id = auth.uid()
    )
  );

revoke all on public.notification_reads from anon;
grant select, insert on public.notification_reads to authenticated;


-- ============================================================================
-- 3. Storage bucket "form-template-sources" -- the uploaded PDF form
--    templates. Bucket itself is marked private, but the anon-role storage
--    policy still let anyone with the anon key list/download/upload/replace/
--    delete every file in it via the API directly, bypassing the app --
--    and, separately, doesn't apply to a real signed-in session at all,
--    which is why authenticated uploads (saving a PDF-based form) fail with
--    an RLS error until this runs. Matches the pattern already used for
--    every other bucket in this project (company-w9s, staff-documents,
--    project-covers, etc.) after the lockdown pass.
-- ============================================================================

drop policy if exists "form_template_sources_bucket_anon_all" on storage.objects;
drop policy if exists "form_template_sources_bucket_authenticated" on storage.objects;

create policy "form_template_sources_bucket_authenticated"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'form-template-sources')
  with check (bucket_id = 'form-template-sources');


-- ============================================================================
-- 4. Hygiene only, not currently exploitable: form_submissions_delete_anon
--    and form_submissions_update_anon are two orphaned policies from before
--    the lockdown pass. They were never dropped by name, but they're
--    currently inert -- supabase-rls-lockdown.sql already ran
--    "revoke all on public.form_submissions from anon", which removes the
--    underlying table privilege the anon role would need for either policy
--    to ever fire, regardless of what the policy itself allows. Dropping
--    them anyway so nothing is left that would silently reactivate if a
--    future change ever re-grants anon access to this table for some other
--    reason.
-- ============================================================================

drop policy if exists "form_submissions_delete_anon" on public.form_submissions;
drop policy if exists "form_submissions_update_anon" on public.form_submissions;
