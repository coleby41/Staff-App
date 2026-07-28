-- ============================================================================
-- timesheet_entries: swap PTO for Clock In / Clock Out
--
-- Run this AFTER supabase-timesheet-workflow-setup.sql.
--
-- Employees now punch a clock_in and clock_out time per day instead of
-- typing a PTO hours number. regular_hours is still a stored column — it's
-- computed client-side as (clock_out - clock_in) and saved alongside the
-- times, so every place that already sums regular_hours + overtime_hours
-- (Accounting dashboard, Manager portal, approved queue) keeps working
-- without touching its math. Overtime stays a manual entry, unchanged.
--
-- No data has gone through this table yet (feature just shipped), so this
-- is a clean drop/add rather than a backfill migration.
-- ============================================================================

alter table public.timesheet_entries
  drop column if exists pto_hours;

alter table public.timesheet_entries
  add column if not exists clock_in time;

alter table public.timesheet_entries
  add column if not exists clock_out time;
