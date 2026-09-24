-- ============================================================================
-- WIPE ALL FORMS DATA (Incident Reports, Back Charges, VPOs) — fresh start
-- ============================================================================
-- Coleby: "erase all of the forms data with IR and any BC and VPO with the
-- new system to start fresh." This removes every Incident Report, Back
-- Charge, and VPO record (and everything filed from them) and resets every
-- numbering counter back to 001, in every project.
--
-- THIS IS DESTRUCTIVE AND IRREVERSIBLE. There is no undo once you run
-- Section 3. If you only want to reset ONE project's test data rather than
-- every project's, see the "SCOPING TO ONE PROJECT" note near the bottom
-- before running anything.
--
-- WHAT THIS DELETES:
--   - Every row in incident_reports, incident_report_events, back_charges, vpos
--   - Every project_files row that was FILED from one of those — i.e. every
--     row with incident_report_id, back_charge_id, or vpo_id set. This is
--     what makes the filed documents disappear from Project Files and Form
--     Logs.
--   - Resets incident_report_counters, bc_counters, vpo_building_counters,
--     and vpo_project_counters, so the next report/BC/VPO created in ANY
--     project starts back at 001 (or building-seq 1 / project-total 1, for
--     VPO).
--
-- WHAT THIS DOES NOT TOUCH:
--   - incident_report_settings — your default approver stays set. You will
--     NOT need to re-do "Set Approver" after running this.
--   - bc_default_template / vpo_default_template / bc_project_templates /
--     vpo_project_templates — your uploaded (or bundled) templates stay
--     exactly as they are.
--   - form_submissions and any project_files row filed from the older Form
--     Builder system, or a plain manual upload — this script only touches
--     Incident Report / BC / VPO data, nothing else in Project Files.
--   - projects, staff_users, Companies, and everything else in the app.
--
-- STORAGE NOTE — READ BEFORE RUNNING:
-- Deleting a project_files row here removes it from the app's own listings
-- (Project Files, Form Logs, etc.), but Postgres has no way to reach into
-- Supabase Storage itself — the actual .docx/.pdf files this script is
-- about to orphan (in the project-documents bucket, and every raw
-- attachment in incident-report-attachments) are NOT deleted by this
-- script and will keep sitting in Storage, invisible to the app but still
-- taking up space. Section 2 below lists exactly which project-documents
-- files are about to become orphaned, so you can go delete them by hand
-- from the Supabase Dashboard → Storage → project-documents afterward if
-- you want them gone too — or just leave them; they're harmless clutter
-- the app will never reference again. The whole incident-report-attachments
-- bucket is used ONLY for IR attachments, so it's safe to just empty that
-- entire bucket from the Dashboard in one go if you're starting fresh.
--
-- HOW TO RUN:
-- Sections 1 and 2 are read-only sanity checks — run them first, separately,
-- if you want to see exactly what's about to be removed (the Supabase SQL
-- Editor only shows the LAST statement's results, so run each SELECT on its
-- own if you want to see both). Section 3 is the actual wipe — it's wrapped
-- in one transaction, so if anything in it fails, nothing is deleted, and it
-- ends with its own verification query so you'll see all-zero counts the
-- moment it finishes.
-- ============================================================================


-- ============================================================================
-- SECTION 1 (optional, read-only) — counts of everything about to be deleted
-- ============================================================================
select
  (select count(*) from public.incident_reports)        as incident_reports,
  (select count(*) from public.incident_report_events)  as incident_report_events,
  (select count(*) from public.back_charges)            as back_charges,
  (select count(*) from public.vpos)                    as vpos,
  (select count(*) from public.project_files
     where incident_report_id is not null
        or back_charge_id is not null
        or vpo_id is not null)                          as filed_project_files;


-- ============================================================================
-- SECTION 2 (optional, read-only) — the actual files about to be orphaned in
-- Storage, in case you want to go delete them by hand afterward
-- ============================================================================
select bucket, storage_path, source, file_name
from public.project_files
where incident_report_id is not null
   or back_charge_id is not null
   or vpo_id is not null
order by source, storage_path;


-- ============================================================================
-- SECTION 3 — THE WIPE (run this as one block)
-- ============================================================================
begin;

-- 3a. Filed documents first — their FKs are ON DELETE SET NULL, not CASCADE,
--     so they'd otherwise survive as orphaned rows pointing at a deleted
--     report/BC/VPO.
delete from public.project_files
where incident_report_id is not null
   or back_charge_id is not null
   or vpo_id is not null;

-- 3b. Back Charges and VPOs. (incident_reports' own ON DELETE CASCADE would
--     take care of these too once step 3c runs, but deleting them explicitly
--     here doesn't depend on that cascade behaving as expected.)
delete from public.back_charges;
delete from public.vpos;

-- 3c. The incident report timeline log, then the incident reports themselves.
delete from public.incident_report_events;
delete from public.incident_reports;

-- 3d. Reset every numbering counter so the next report/BC/VPO in any project
--     starts back at 001.
delete from public.incident_report_counters;
delete from public.bc_counters;
delete from public.vpo_building_counters;
delete from public.vpo_project_counters;

-- 3e. Verify — every count below should read 0. This is the last statement
--     in the block, so its result is what the SQL Editor will show you.
select
  (select count(*) from public.incident_reports)          as incident_reports,
  (select count(*) from public.incident_report_events)    as incident_report_events,
  (select count(*) from public.back_charges)              as back_charges,
  (select count(*) from public.vpos)                      as vpos,
  (select count(*) from public.project_files
     where incident_report_id is not null
        or back_charge_id is not null
        or vpo_id is not null)                             as filed_project_files,
  (select count(*) from public.incident_report_counters)  as ir_counters,
  (select count(*) from public.bc_counters)                as bc_counters,
  (select count(*) from public.vpo_building_counters)      as vpo_building_counters,
  (select count(*) from public.vpo_project_counters)       as vpo_project_counters;

commit;


-- ============================================================================
-- SCOPING TO ONE PROJECT INSTEAD OF EVERY PROJECT
-- ============================================================================
-- Everything above wipes ALL projects. If you only want to reset one
-- project's test data (leaving every other project's real IR/BC/VPO history
-- alone), replace Section 3 with this instead — same order, each delete
-- narrowed to one project_id, plus a matching incident_report_id/back_charge
-- /vpo filter on project_files since that table doesn't carry project_id
-- directly for every row shape used here:
--
--   begin;
--
--   delete from public.project_files
--   where (incident_report_id in (select id from public.incident_reports where project_id = '<PROJECT_ID>'))
--      or (back_charge_id in (select id from public.back_charges where project_id = '<PROJECT_ID>'))
--      or (vpo_id in (select id from public.vpos where project_id = '<PROJECT_ID>'));
--
--   delete from public.back_charges where project_id = '<PROJECT_ID>';
--   delete from public.vpos where project_id = '<PROJECT_ID>';
--   delete from public.incident_report_events
--   where incident_report_id in (select id from public.incident_reports where project_id = '<PROJECT_ID>');
--   delete from public.incident_reports where project_id = '<PROJECT_ID>';
--
--   delete from public.incident_report_counters where project_id = '<PROJECT_ID>';
--   delete from public.bc_counters where project_id = '<PROJECT_ID>';
--   delete from public.vpo_building_counters where project_id = '<PROJECT_ID>';
--   delete from public.vpo_project_counters where project_id = '<PROJECT_ID>';
--
--   commit;
--
-- Find a project's id first with: select id, name from public.projects;
-- ============================================================================
