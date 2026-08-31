-- ============================================================================
-- supabase-open-project-financials-to-all-staff.sql
--
-- Coleby, follow-up to the two "everyone has access" migrations above:
-- "everyone should see the finace [finance]." Confirmed this is specifically
-- about VISIBILITY of dollar figures, not about who can approve/create a
-- change order (a separate spend-approval control, left untouched below).
--
-- WHAT WAS STILL HIDDEN: `projects_overview` masked contract_value,
-- electric/water/trash/porta-potty account numbers, and (if
-- supabase-project-dashboard-schema.sql has been run) committed_amount /
-- spent_to_date — showing real values only to staff whose project_members
-- row gave them has_financial_access() on that specific project.
-- change_orders_overview masked its own `amount` column the same way, and
-- the underlying change_orders table's SELECT policy was still gated to
-- is_project_member() (a visibility gap of the same kind already closed on
-- every other project-content table by supabase-open-project-access-to-
-- all-staff.sql — this table just wasn't caught in that sweep since it
-- lives in a different schema file).
--
-- WHAT THIS DOES: removes the has_financial_access() masking from both
-- views (every authenticated staff member now sees the real numbers), and
-- opens SELECT on change_orders itself to any authenticated staff member.
--
-- NOT touched, on purpose: change_orders' INSERT (who can request a change
-- order), UPDATE (who can approve/reject one), and DELETE policies stay
-- exactly as they are (project_admin/project_manager/accounting to create,
-- project_admin/accounting to approve, project_admin to delete) — approving
-- spend is a distinct control from being able to see the dollar amount, and
-- wasn't part of this request. Ask explicitly if you want that opened too.
--
-- PREREQUISITE: this redefines the WIDER (28-column, with committed_amount/
-- spent_to_date) version of projects_overview, so run this AFTER
-- supabase-project-dashboard-schema.sql if that hasn't already been applied
-- to this database. If it hasn't been run at all, drop the last two
-- columns (committed_amount, spent_to_date) from the select list below
-- before running this file, or just run supabase-project-dashboard-schema.sql
-- first (its own copy of the view is also unmasked now, so you don't have
-- to touch this file either way).
--
-- Safe to re-run. Run in Supabase → SQL Editor.
-- ============================================================================


-- ============================================================================
-- 1. projects_overview — unmasked. `drop ... cascade` + `create` (not
--    `create or replace`) for the same reason the original view used it:
--    Postgres won't let CREATE OR REPLACE change a view's column list.
-- ============================================================================

drop view if exists public.projects_overview cascade;
create view public.projects_overview
with (security_invoker = true)
as
select
  id, name, is_active, created_at, updated_at, created_by_id, created_by_name,
  owner_name, owner_phone, owner_email, owner_address,
  site_address, site_city, site_state, site_zip,
  gc_name, gc_phone, gc_email,
  poc_name, poc_role, poc_phone, poc_email,
  site_plans_status, site_plans_notes, site_plans_file_path,
  permit_number, permit_plans_status, permit_plans_notes, permit_plans_file_path,
  electric_provider, water_provider, other_utilities_notes,
  trash_vendor, porta_potty_vendor, temp_services_notes,
  county_city_office_name, county_city_contact_name, county_city_phone, county_city_email,
  status, project_manager_name, progress_percent, due_date,
  updated_by_id, updated_by_name, cover_photo_url,
  contract_value, electric_account_number, water_account_number,
  trash_account_number, porta_potty_account_number,
  committed_amount, spent_to_date
from public.projects;

grant select on public.projects_overview to authenticated;


-- ============================================================================
-- 2. change_orders — open SELECT to any authenticated staff member (was
--    is_project_member(project_id)); unmask `amount` on change_orders_overview.
--    No-ops harmlessly if supabase-project-dashboard-schema.sql (which
--    creates change_orders) hasn't been run yet.
-- ============================================================================

do $$
begin
  if to_regclass('public.change_orders') is not null then
    execute 'drop policy if exists "change_orders_select_members" on public.change_orders';
    execute 'drop policy if exists "change_orders_select_authenticated" on public.change_orders';
    execute $p$create policy "change_orders_select_authenticated" on public.change_orders for select to authenticated using (true)$p$;

    execute $v$create or replace view public.change_orders_overview
      with (security_invoker = true)
      as
      select
        id, project_id, number, title, description, status,
        requested_by, requested_by_name, approved_by, approved_by_name, approved_at,
        created_at, updated_at,
        amount
      from public.change_orders$v$;

    execute 'grant select on public.change_orders_overview to authenticated';
  else
    raise notice 'public.change_orders not found — skipped (supabase-project-dashboard-schema.sql not run yet).';
  end if;
end $$;

-- ============================================================================
-- Done. Sanity check:
--   select contract_value, electric_account_number, committed_amount,
--     spent_to_date from public.projects_overview limit 5;  -- real values for everyone now
--   select amount from public.change_orders_overview limit 5;  -- real values for everyone now
-- ============================================================================
