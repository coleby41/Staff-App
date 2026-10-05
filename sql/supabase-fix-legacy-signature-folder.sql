-- ============================================================================
-- Fix: "Submit Old Forms" legacy VPO/BC imports filed their original PDF
-- into the With Signature subfolder; Coleby wants them in Without Signature
-- instead (2026-10-05), matching the default subfolder a freshly
-- auto-generated VPO/BC already gets. js/project-form-logs.js has been
-- fixed going forward (subSubfolderOverride changed from "vpo_with_signature"
-- / "bc_with_signature" to "vpo_without_signature" / "bc_without_signature")
-- -- this script only corrects records that were already filed under the
-- old behavior.
--
-- Safe to run more than once (WHERE clauses only match rows still sitting
-- in the old subfolder). Only touches project_files rows that trace back,
-- through their vpo/back_charge row's incident_report_id, to a shell report
-- flagged is_legacy_migration = true -- a real, non-migrated VPO/BC whose
-- signed copy you uploaded by hand into With Signature yourself is left
-- alone. No files are moved in Storage; the app decides which folder a
-- file shows up in purely from project_files.category/subfolder/
-- sub_subfolder, not from the storage path string, so updating this one
-- column is enough.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Step 1 -- preview what this will touch before changing anything. Expect
-- one row per legacy VPO/BC's original PDF that's currently misfiled.
-- ---------------------------------------------------------------------------

select
  pf.id as project_file_id,
  pf.project_id,
  pf.file_name,
  pf.sub_subfolder as current_sub_subfolder,
  case when pf.vpo_id is not null then 'vpo_without_signature' else 'bc_without_signature' end as will_become,
  coalesce(v.vpo_number, bc.bc_number) as old_id,
  ir.ir_number
from public.project_files pf
left join public.vpos v on v.id = pf.vpo_id
left join public.back_charges bc on bc.id = pf.back_charge_id
join public.incident_reports ir
  on ir.id = coalesce(v.incident_report_id, bc.incident_report_id)
where ir.is_legacy_migration = true
  and pf.sub_subfolder in ('vpo_with_signature', 'bc_with_signature')
order by pf.project_id, old_id;

-- ---------------------------------------------------------------------------
-- Step 2 -- the actual fix. Run only after Step 1's preview looks right.
-- ---------------------------------------------------------------------------

update public.project_files pf
set sub_subfolder = 'vpo_without_signature'
from public.vpos v
join public.incident_reports ir on ir.id = v.incident_report_id
where pf.vpo_id = v.id
  and ir.is_legacy_migration = true
  and pf.sub_subfolder = 'vpo_with_signature';

update public.project_files pf
set sub_subfolder = 'bc_without_signature'
from public.back_charges bc
join public.incident_reports ir on ir.id = bc.incident_report_id
where pf.back_charge_id = bc.id
  and ir.is_legacy_migration = true
  and pf.sub_subfolder = 'bc_with_signature';

-- ---------------------------------------------------------------------------
-- Step 3 -- confirm nothing matching the old condition is left.
-- ---------------------------------------------------------------------------

select count(*) as still_misfiled
from public.project_files pf
left join public.vpos v on v.id = pf.vpo_id
left join public.back_charges bc on bc.id = pf.back_charge_id
join public.incident_reports ir
  on ir.id = coalesce(v.incident_report_id, bc.incident_report_id)
where ir.is_legacy_migration = true
  and pf.sub_subfolder in ('vpo_with_signature', 'bc_with_signature');
-- should return 0
