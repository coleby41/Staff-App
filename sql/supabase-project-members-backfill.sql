-- ============================================================================
-- supabase-project-members-backfill.sql
--
-- STEP 3 of the security re-architecture. Run this AFTER
-- supabase-auth-rearchitecture-schema.sql AND after
-- scripts/migrate-staff-to-auth.ts has populated staff_users.auth_user_id for
-- everyone (this file joins on that column — anyone without it yet gets
-- skipped and simply won't be backfilled, so run the Auth migration first).
--
-- Why this exists: today, every authenticated user would see NO projects at
-- all the moment RLS starts requiring project_members rows, because that
-- table starts empty. This is a one-time "day-one parity" seed so nobody
-- currently using the app loses access the moment the RLS lockdown runs — it
-- gives every active staff member a row on every EXISTING project, with a
-- role derived from their current workgroup. Projects created AFTER this
-- point need explicit project_members rows going forward (project_admins can
-- insert these themselves once RLS is live — see the lockdown migration's
-- policy on project_members).
--
-- Mapping used (per Coleby's direction — workgroup stays the org-wide model,
-- this is just a reasonable starting point for the new project-level role,
-- adjust individual rows afterward as needed):
--   Super Admin, IT          -> project_admin
--   Accounting                -> accounting (+ can_view_financials)
--   Owner, Office              -> project_manager
--   Field, Operations, other -> staff
--
-- Safe to re-run: every insert uses ON CONFLICT DO NOTHING, so re-running
-- this after adding a new project or a new staff member just fills in the
-- gaps without disturbing any role you've since changed by hand.
--
-- Run this in Supabase → SQL Editor, top to bottom, in one go.
-- ============================================================================

-- Small local helper — handles staff_users.workgroup being either text[] or
-- plain text (same both-shapes handling as is_super_admin()/is_workgroup()
-- in the schema migration). Dropped at the end since nothing else needs it
-- after this one-time backfill.
create or replace function public.is_workgroup_static(p_workgroup anyelement, p_name text)
returns boolean
language sql
immutable
as $$
  select case
    when pg_typeof(p_workgroup)::text = 'text[]' then p_name = any(p_workgroup::text[])
    else p_workgroup::text = p_name
  end;
$$;

insert into public.project_members (project_id, user_id, role, can_view_financials, created_by)
select
  p.id as project_id,
  su.auth_user_id as user_id,
  case
    when public.is_workgroup_static(su.workgroup, 'Super Admin') or public.is_workgroup_static(su.workgroup, 'IT')
      then 'project_admin'
    when public.is_workgroup_static(su.workgroup, 'Accounting')
      then 'accounting'
    when public.is_workgroup_static(su.workgroup, 'Owner') or public.is_workgroup_static(su.workgroup, 'Office')
      then 'project_manager'
    else 'staff'
  end as role,
  public.is_workgroup_static(su.workgroup, 'Accounting') as can_view_financials,
  su.id as created_by
from public.projects p
cross join public.staff_users su
where su.auth_user_id is not null
  and su.active is not false
on conflict (project_id, user_id) do nothing;

drop function public.is_workgroup_static(anyelement, text);
