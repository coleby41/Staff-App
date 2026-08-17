# Security re-architecture rollout runbook

Do these steps **in order**, in a maintenance window. Steps 1–3 are safe to run
while the app is live (purely additive). Steps 4–6 are the breaking part —
everyone gets signed out and has to log back in, and every table stops being
readable/writable by the anon key.

## 1. Run the additive schema migration
Supabase → SQL Editor → run `SQL FILES/supabase-auth-rearchitecture-schema.sql`
in full. Confirm no errors. The app keeps working exactly as before — nothing
is removed yet.

## 2. Migrate every staff member to real Supabase Auth
Run `scripts/migrate-staff-to-auth.ts` locally (needs Deno):

```
SUPABASE_URL=https://ostaqjuawieqpwuhrvsm.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<from Supabase → Project Settings → API> \
deno run --allow-net --allow-env scripts/migrate-staff-to-auth.ts
```

This prints a table of `username / temp_password` at the end — **that's the
only place those temp passwords are ever shown.** Hand each one to that
person individually (Slack DM, in person — not a shared doc), and let them
know they'll be forced to set their own password the first time they log in.

## 3. Backfill project access
Supabase → SQL Editor → run `SQL FILES/supabase-project-members-backfill.sql`.
This gives everyone access to every *existing* project (role derived from
their workgroup) so nobody loses access once RLS locks down. Confirm it ran
by spot-checking `select count(*) from project_members;` — should be
roughly (staff count) × (project count).

## 4. Deploy the Edge Functions
```
supabase functions deploy create-staff-account
supabase functions deploy reset-staff-password
```
(Both need `SUPABASE_SERVICE_ROLE_KEY` set as a secret on the project — it
already should be, since `calendar-disconnect` etc. use the same one. Check
with `supabase secrets list`.)

## 5. Ship the client files
Replace these files in the repo with the versions in this delivery, then
deploy/push as you normally would:

- `supabase-auth.js`
- `auth-guard.js`
- `login.html`
- `login.js`
- `project-fields.js`
- `project-shell.js`
- `projects-page.js`
- `staff-users.js`

`admin-users.html` / `admin-users.js` are **unchanged** — account creation
now goes through the Edge Function automatically because
`window.createSupabaseUser()`'s signature didn't change, only what it does
internally.

At this point, login works through real Supabase Auth, but RLS is still
open — this is a good moment to log in as yourself and confirm the app looks
and behaves exactly as before (including being forced through the "set a new
password" step from step 2).

## 6. Flip RLS — the step that actually closes the hole
Supabase → SQL Editor → run `SQL FILES/supabase-rls-lockdown.sql` in full.
Everyone (including you) gets signed out. Log back in with your new password.

## 7. Verify
- From a terminal (NOT the app), confirm the anon key can no longer read
  anything:
  ```
  curl "https://ostaqjuawieqpwuhrvsm.supabase.co/rest/v1/projects?select=*" \
    -H "apikey: <the anon key from supabase-config.js>"
  ```
  Should return `[]` or a permission error — not real project data.
- Log in as a Super Admin, an Accounting test account, and a plain Staff
  test account. Confirm:
  - Each sees the projects they should on Project Overview.
  - Contract value / utility account numbers show for Accounting/Super Admin
    and are blank ("Nothing on file yet") for a plain Staff account on the
    **same** project.
  - Changing `?id=` in a project-dashboard URL to a project the Staff test
    account isn't a member of now fails to load instead of showing data.
  - Payroll Tools still works end to end for an Accounting account: roster,
    approvals, PDF generation into another employee's staff-documents
    folder.
  - A manager can still see and approve their direct reports' timesheets
    (Manage Employees).
  - Staff Users admin page: editing a user's role/workgroup, and resetting
    someone's password (should now actually change their real login, not
    just an inert `password_hash` column).
- Check `audit_log` gets rows for: changing a test account's role/workgroup,
  adding/removing a `project_members` row, and editing a project's contract
  value.
- **Test the financial masking behavior specifically** before trusting it in
  production: log in as a Staff-role test account with no financial access
  on a project, load that project's Overview page, and confirm the page
  loads normally with the financial section blank (rather than erroring).
  `projects_overview`'s masking relies on this — see the comment above it in
  `supabase-rls-lockdown.sql` if anything looks off.

## 8. Project dashboard redesign (RFIs / Change Orders / Submittals / activity feed)
Only run this **after** steps 1–7 are fully done and verified — it calls
`is_project_member()`, `project_role()`, and `has_financial_access()`
directly, which don't exist until the security re-architecture above is
live.

Supabase → SQL Editor → run `SQL FILES/supabase-project-dashboard-schema.sql`
in full. This is additive/safe to run while the app is live:
- Adds `rfis`, `change_orders` (+ `change_orders_overview` masking view),
  `submittals`, `project_events`, and an append-only `project_activity`
  feed, each with RLS following the same `is_project_member()`/
  `project_role()`/`has_financial_access()` pattern as everything else.
- Adds `projects.committed_amount`/`spent_to_date` and extends
  `projects_overview` to mask them the same way as `contract_value`.
- Closes an RLS gap on `project_timeline_items`/`project_todo_items`/
  `project_todo_subitems` — those three predated the security
  re-architecture and still had `to anon using (true)` policies; this
  replaces them with `is_project_member()`-gated ones.

I test-ran this migration end-to-end against a real Postgres 16 instance
(schema + RLS + the `committed_amount` trigger + the activity-log triggers)
before delivering it — it applied cleanly, and the RLS behavior verified
correctly: a project outsider sees 0 rows and is blocked from inserting; a
non-financial project member sees change order titles but not amounts; a
direct client insert into `project_activity` is rejected (only the trigger
helper can write there).

Then ship these client files the same way as step 5:
- `projects.html` (redesigned Overview — status pill, stat tiles, timeline
  snapshot, attention needed, upcoming events, financial snapshot donut,
  recent activity; existing wizard-field content moved below under
  "Project Details")
- `project-fields.js` (adds `layout: "contact"` to the 4 contact-style
  wizard steps — no fields added/removed)
- `projects-page.js` (wizard restyle: numbered step header, contact-block
  grouping, field grid)
- `project-timeline.html`, `project-to-do.html` (sidebar nav updated with
  the 3 new tabs)
- `styles.css`
- New: `project-rfis.html`, `project-rfis.js`, `project-change-orders.html`,
  `project-change-orders.js`, `project-submittals.html`,
  `project-submittals.js`

**Verify:**
- Open a project's Overview tab — confirm the 6 stat tiles, timeline
  snapshot, and panels render (empty states are fine on a project with no
  RFIs/change orders/events yet).
- Create an RFI as a plain Staff project member, confirm it shows up in
  Attention Needed and Recent Activity.
- Submit a change order with an amount, approve it as a project_admin/
  Accounting test account, confirm `projects.committed_amount` updates and
  the amount is visible there but blank for a Staff test account without
  financial access on the same project.
- Open the onboarding wizard (Edit Project on any project) and confirm the
  4 contact-style steps (Property Owner, General Contractor, Point of
  Contact, County/City Office) render as one grouped card each, and that no
  data that used to be there is missing.

## 9. All Files (folder taxonomy + form-template auto-filing; RFIs/Change Orders/Submittals/Site Plans/Contract removed)
This replaces the dedicated RFI/Change Order/Submittal tracking pages from
step 8 with a different approach: **any** form gets submitted through the
existing form-builder system and filed as a document into a project's new
"All Files" tab, organized under a fixed 11-category folder taxonomy. Only
run this after step 8 is live — it adds columns to `form_templates`/
`form_submissions` and calls `is_project_member()`/`project_role()`/
`current_staff_id()` directly.

**What already happened, ahead of this SQL step:** the RFIs, Change Orders,
Submittals, Site Plans, and Contract sidebar tabs/pages were removed from
the app (moved to `_to_delete/` in the repo — delete that folder once you've
confirmed you don't need anything from it). Per your call, the underlying
`rfis`/`change_orders`/`submittals` tables and data were **left in place**,
just no longer reachable from the UI — nothing to migrate or lose.

Supabase → SQL Editor → run `SQL FILES/supabase-project-files-schema.sql` in
full. Additive/safe to run while the app is live:
- Adds `form_templates.default_category`/`default_subfolder` (nullable) —
  set once per template (by whoever can already manage that form) to file
  every submission of it into a fixed project folder. Left null, a template
  behaves exactly as it does today (e.g. HR-style org-wide forms) —
  completely unaffected.
- Adds `form_submissions.project_id` (nullable) — same backward-compatible
  story; every existing submission and every future non-project-mapped
  submission keeps this null.
- New `project_files` table — the single index the All Files page queries,
  populated either by a plain manual upload or automatically (via a
  `security definer` trigger, `file_form_submission()`) the moment a
  project-mapped template's submission is inserted. RLS: any project member
  can see/add; only the uploader or project leadership
  (project_admin/project_manager) can update/delete — same shape as the RFI
  answer permissions from step 8.
- Manual uploads reuse the existing `project-documents` storage bucket and
  its policy unchanged (category/subfolder are just extra path segments
  after the project id, which is all that policy ever checked).

I test-ran this migration end-to-end against a real Postgres 16 instance
(schema + RLS + both triggers) before delivering it, using a fixture
standing in for the real staff_users/projects/project_members/security
functions — applied cleanly, and functionally verified: a project member
can upload into their own project and sees it; a non-member sees 0 files in
that project and is rejected on insert; the uploader and a project_admin
can each delete a file but a same-project non-uploader/non-leadership
member cannot; a project-mapped template's submission auto-files into
exactly the right folder with the right uploader; an un-mapped template's
submission and any submission with no project_id are completely unaffected
(no filing, nothing changes).

Then ship these client files the same way as step 5:
- `project-fields.js` (adds `PROJECT_FILE_CATEGORIES` — the shared 11-category
  taxonomy constant — and a generalized `uploadFile()` helper)
- `projects-page.js` (delegates its existing upload helper to the shared
  one above — no behavior change)
- `form-builder.js` / `form-template.html` (optional "file into a project
  folder?" category/subfolder pickers when creating/editing a template;
  a project picker when filling out a project-mapped template, skipped
  automatically when you arrive via a project's All Files "+ Fill" link)
- `styles.css` (adds the All Files folder-tree/file-row styling)
- New: `project-files.html`, `project-files.js` (the All Files page itself
  — wires up the sidebar's pre-existing "Project Files" nav link, which
  pointed here since step 8 but had no page behind it until now)

**Verify:**
- Create a form template as IT/Office/Super Admin, set its folder mapping
  (e.g. Construction → Daily Reports), fill it out from a project's All
  Files page (via "+ Fill \<template\>" in that folder) — confirm the PDF
  lands and shows up in that exact folder with no second manual step.
- Fill the same template from the global Forms page (no project context) —
  confirm a project picker appears and files it correctly.
- Fill an existing org-wide form (e.g. an HR-style template with no folder
  mapping) — confirm nothing changed: no project picker, no filing, same as
  before this step.
- As a plain Staff project member, manually upload a file into a folder —
  confirm another member of the same project can see and open it, and a
  non-member test account cannot.
- Confirm a non-uploader, non-admin project member can't delete someone
  else's filed document, but the uploader and a project_admin both can.
- Once you're confident, delete the `_to_delete/` folder from the repo.

## Known follow-ups (not done in this pass)
- `Companies` (vendors) table: locked to `authenticated`, but `"SSN/FID"`
  isn't field-masked yet — I don't have that table's full column list. Get
  `\d "Companies"` from the SQL editor and I can add the same
  `projects_overview`-style masking view for it.
- No "Manage Access" UI yet for adding someone to a *new* project's
  `project_members` — project admins can do it via a direct insert (RLS
  allows it) but there's no button for it yet.
- `timesheet_events` doesn't enforce a real state machine (e.g. blocking an
  "approved" event from someone who isn't currently reviewing) — it checks
  who's allowed to touch the timesheet, not which transitions are valid from
  which status. Same trust level as today's UI-driven flow, just backed by
  RLS now.
- I did a targeted compatibility pass (checked how `payroll_employees`,
  `timesheets`, `manage-employees.js`, `payroll-tools.js`, `payroll-pdf-stub.js`,
  and `staff-users.js` actually read/write data) but did not read every
  remaining page script line by line (`form-builder.js`, `companies.js` in
  full, `venders.js`, `workgroups.js`, `excel-workbook.html`, `my-tasks.html`,
  `staff-to-do.html`, notifications, dashboard cards). Those should keep
  working unmodified through the shared-client mechanism, but give them a
  smoke test after step 6, same as anything else.
- Once you've confirmed everyone has logged in successfully at least once
  post-migration, run the commented-out last line of
  `supabase-rls-lockdown.sql` to drop `staff_users.password_hash` for good.
- `spent_to_date` has no data source yet (no invoicing/AP integration) — a
  financial-access user edits it by hand for now. There's no inline editor
  built for `committed_amount`/`spent_to_date` on the dashboard yet either;
  for now, set them directly via SQL Editor
  (`update projects set spent_to_date = ... where id = '...'`) or add one.
- QuickBooks Online: you want some accounting content on the dashboard
  without double entry against QBO — this needs a real conversation about
  what should live in QBO vs. what's project-specific (and, if you want live
  numbers on the dashboard, an Intuit developer app + OAuth connection),
  before anything gets built here. Not started yet.
- Editing an already-filed form submission keeps its original project (the
  project picker only appears if the submission doesn't already know its
  project) — this is deliberate, since the auto-filing trigger only fires
  on insert, not update. If you ever need to move an old submission into a
  newly-mapped folder, that's a one-off manual `project_files` insert, not
  something the UI does for you today.
- Dashboard's "Attention Needed" panel now only shows Overdue Tasks — RFIs/
  Change Orders/Submittals no longer have a dedicated status to surface
  there now that they're filed as documents instead of tracked records.
