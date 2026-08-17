-- ============================================================================
-- supabase-auth-rearchitecture-schema.sql
--
-- STEP 1 of the security re-architecture. This file is purely ADDITIVE —
-- it does not touch any existing RLS policy, does not remove anon access,
-- and does not change how login works yet. Safe to run against production
-- while the app keeps working exactly as it does today. Nothing here takes
-- effect until the later migrations (project-members backfill, then the RLS
-- lockdown) are run.
--
-- Adds:
--   1. Real-Supabase-Auth link columns on staff_users
--   2. project_members — the new per-project RBAC table
--   3. audit_log — append-only security/audit trail
--   4. Helper functions used by every RLS policy in the lockdown migration
--   5. Audit triggers on staff_users / project_members / projects
--
-- Run this in Supabase → SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. staff_users: link to auth.users, keep username-based login UX
--
-- Staff keep typing their existing username + password on the login screen.
-- Under the hood, each staff_users row gets a real auth.users account with a
-- synthetic, never-shown email (auth_email) so Supabase Auth issues a real,
-- cryptographically verifiable session (auth.uid()) instead of the current
-- "JSON blob in localStorage" model. See scripts/migrate-staff-to-auth.ts for
-- the one-time backfill that populates auth_user_id/auth_email for existing
-- rows, and supabase/functions/create-staff-account for how new accounts get
-- created going forward (server-side only, IT/Super Admin gated).
-- ----------------------------------------------------------------------------

alter table public.staff_users
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null,
  add column if not exists auth_email text unique,
  add column if not exists must_reset_password boolean not null default false;

create index if not exists staff_users_auth_user_id_idx on public.staff_users (auth_user_id);


-- ----------------------------------------------------------------------------
-- 2. project_members — per-project RBAC, separate from workgroups.
--
-- Workgroups stay exactly as they are today (org-wide nav access — who sees
-- Payroll Tools, IT Tools, etc.). project_members is the new, additional
-- layer the security spec calls for: explicit, per-user, per-project
-- authorization, so "this person can see project X" is a real row in the
-- database instead of an assumption that every signed-in person can see
-- every project.
--
-- role is intentionally project-scoped and independent of workgroup — e.g.
-- someone can be workgroup "Field" org-wide but "project_admin" on one
-- specific project. can_view_financials is its own flag (not implied by
-- role) so a Project Manager can be added to a project without automatically
-- getting financial visibility, per the spec's "separate financial
-- permissions from general project access" requirement.
-- ----------------------------------------------------------------------------

create table if not exists public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('project_admin', 'project_manager', 'accounting', 'staff', 'viewer')),
  can_view_financials boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references public.staff_users(id),
  unique (project_id, user_id)
);

create index if not exists project_members_project_id_idx on public.project_members (project_id);
create index if not exists project_members_user_id_idx on public.project_members (user_id);

alter table public.project_members enable row level security;
-- (select/insert/update/delete policies added in the RLS lockdown migration,
--  once the helper functions below exist for them to call.)


-- ----------------------------------------------------------------------------
-- 3. audit_log — append-only. No update/delete policy is ever added for any
-- non-service-role client, by design (see spec: "users should NOT be able to
-- modify or delete their own audit records").
-- ----------------------------------------------------------------------------

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  staff_id uuid references public.staff_users(id),
  project_id uuid references public.projects(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_at_idx on public.audit_log (created_at);
create index if not exists audit_log_project_id_idx on public.audit_log (project_id);
create index if not exists audit_log_staff_id_idx on public.audit_log (staff_id);

alter table public.audit_log enable row level security;

-- Only readable by Super Admin / IT (checked via helper functions below,
-- policy added in the lockdown migration). Writes only ever happen via the
-- SECURITY DEFINER helper below (called from triggers), never directly from
-- a client role — there is deliberately no insert policy for `authenticated`.


-- ----------------------------------------------------------------------------
-- 4. Helper functions — the vocabulary every RLS policy in the lockdown
-- migration is written in terms of. All are STABLE (safe to use in RLS) and
-- SECURITY DEFINER where they need to read staff_users/project_members
-- without themselves being blocked by those tables' own RLS.
-- ----------------------------------------------------------------------------

-- The staff_users row for whoever is currently authenticated. Returns null
-- for anon / anyone without a linked staff_users row.
create or replace function public.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.staff_users where auth_user_id = auth.uid();
$$;

-- Org-wide bypass, same concept as nav-access.js's existing hardcoded
-- "Super Admin always sees everything" — now enforced at the database, not
-- just in the UI.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_users su
    where su.auth_user_id = auth.uid()
      and su.active is not false
      -- workgroup is a real text[] column (confirmed live — a bare string
      -- comparison like `su.workgroup = 'Super Admin'` throws "malformed
      -- array literal" because Postgres tries to parse the literal as array
      -- syntax to match the column's type; = any() is the correct form for
      -- an array column regardless of how many entries a row has).
      and 'Super Admin' = any(su.workgroup)
  );
$$;

-- General "does this signed-in person belong to workgroup X" check — lets
-- RLS policies express the same org-wide gating nav-access.js already does
-- client-side (e.g. Payroll Tools = Office + Accounting + Super Admin) as a
-- real, server-enforced rule instead of a UI-only convenience.
create or replace function public.is_workgroup(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin() or exists (
    select 1
    from public.staff_users su
    where su.auth_user_id = auth.uid()
      and su.active is not false
      and p_name = any(su.workgroup)
  );
$$;

-- Is the signed-in person's role = 'Manager' AND is the given staff_id one
-- of their direct reports (or themselves)? Mirrors manage-employees.js's
-- existing "myTeam" filter (staff_users.manager_id === me).
create or replace function public.is_manager_of(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin() or p_staff_id = public.current_staff_id() or exists (
    select 1 from public.staff_users su
    where su.id = p_staff_id
      and su.manager_id = public.current_staff_id()
      and lower(coalesce((select role from public.staff_users where id = public.current_staff_id()), '')) = 'manager'
  );
$$;

-- Project-level membership check. Super Admin always passes (org-wide
-- bypass), matching the same rule used everywhere else in this app.
create or replace function public.is_project_member(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin() or exists (
    select 1 from public.project_members pm
    where pm.project_id = p_project_id
      and pm.user_id = auth.uid()
  );
$$;

create or replace function public.project_role(p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when public.is_super_admin() then 'project_admin'
    else (select pm.role from public.project_members pm
          where pm.project_id = p_project_id and pm.user_id = auth.uid())
  end;
$$;

-- Financial visibility: Super Admin, or explicitly flagged on this project,
-- or holding a role that carries financial access by default.
create or replace function public.has_financial_access(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin() or exists (
    select 1 from public.project_members pm
    where pm.project_id = p_project_id
      and pm.user_id = auth.uid()
      and (pm.can_view_financials or pm.role in ('project_admin', 'accounting'))
  );
$$;

-- Does the signed-in person have ANY financial permission at all — used for
-- payroll (which isn't tied to a single project). Accounting/Super Admin
-- org-wide, matching payroll-tools.html's existing gating.
create or replace function public.has_payroll_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_workgroup('Accounting') or public.is_workgroup('Office') or public.is_super_admin();
$$;

grant execute on function
  public.current_staff_id(), public.is_super_admin(), public.is_workgroup(text),
  public.is_manager_of(uuid), public.is_project_member(uuid), public.project_role(uuid),
  public.has_financial_access(uuid), public.has_payroll_access()
to authenticated;


-- ----------------------------------------------------------------------------
-- 5. Audit triggers — fire regardless of which client/page made the change,
-- so logging can't be skipped by a page that forgets to call an API.
-- ----------------------------------------------------------------------------

create or replace function public.write_audit_log(
  p_action text, p_entity_type text, p_entity_id text,
  p_project_id uuid, p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (user_id, staff_id, project_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), public.current_staff_id(), p_project_id, p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

create or replace function public.audit_staff_users_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') and (
    old.role is distinct from new.role
    or old.workgroup is distinct from new.workgroup
    or old.active is distinct from new.active
  ) then
    perform public.write_audit_log(
      'staff_user_permissions_changed', 'staff_users', new.id::text, null,
      jsonb_build_object(
        'old_role', old.role, 'new_role', new.role,
        'old_workgroup', old.workgroup, 'new_workgroup', new.workgroup,
        'old_active', old.active, 'new_active', new.active
      )
    );
  elsif (tg_op = 'INSERT') then
    perform public.write_audit_log('staff_user_created', 'staff_users', new.id::text, null,
      jsonb_build_object('role', new.role, 'workgroup', new.workgroup));
  end if;
  return new;
end;
$$;

drop trigger if exists staff_users_audit on public.staff_users;
create trigger staff_users_audit
  after insert or update on public.staff_users
  for each row execute function public.audit_staff_users_change();

create or replace function public.audit_project_members_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.write_audit_log('project_member_removed', 'project_members', old.id::text, old.project_id,
      jsonb_build_object('user_id', old.user_id, 'role', old.role));
    return old;
  else
    perform public.write_audit_log(
      case when tg_op = 'INSERT' then 'project_member_added' else 'project_member_role_changed' end,
      'project_members', new.id::text, new.project_id,
      jsonb_build_object('user_id', new.user_id, 'role', new.role, 'can_view_financials', new.can_view_financials)
    );
    return new;
  end if;
end;
$$;

drop trigger if exists project_members_audit on public.project_members;
create trigger project_members_audit
  after insert or update or delete on public.project_members
  for each row execute function public.audit_project_members_change();

-- Only fires when one of the actually-sensitive financial columns changes,
-- not on every project edit (that would be noisy, not useful).
create or replace function public.audit_project_financials_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.contract_value is distinct from new.contract_value
    or old.electric_account_number is distinct from new.electric_account_number
    or old.water_account_number is distinct from new.water_account_number
    or old.trash_account_number is distinct from new.trash_account_number
    or old.porta_potty_account_number is distinct from new.porta_potty_account_number
  then
    perform public.write_audit_log('project_financials_changed', 'projects', new.id::text, new.id,
      jsonb_build_object('old_contract_value', old.contract_value, 'new_contract_value', new.contract_value));
  end if;
  return new;
end;
$$;

drop trigger if exists projects_financials_audit on public.projects;
create trigger projects_financials_audit
  after update on public.projects
  for each row execute function public.audit_project_financials_change();
