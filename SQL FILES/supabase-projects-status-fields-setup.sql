-- ============================================================================
-- supabase-projects-status-fields-setup.sql
--
-- Adds the tracking fields the redesigned Project Overview page (
-- project-home.html / projects-page.js) needs for its stats header, status
-- badges, card/list views, and tabs: status, project manager, contract
-- value, progress %, due date, and who last updated the record.
--
-- Run supabase-projects-setup.sql FIRST if you haven't already — this file
-- only ALTERs the table it creates. Safe to re-run (every ADD COLUMN uses
-- IF NOT EXISTS).
--
-- Backfill note: existing rows have no way for us to know their real
-- status, so this sets status from the only signal that already exists
-- (is_active): is_active = true -> 'active', is_active = false ->
-- 'archived'. New rows default to 'onboarding'. Go back and correct any
-- project the backfill got wrong from its card (click the status badge).
--
-- Run this in Supabase → SQL Editor.
-- ============================================================================

alter table public.projects
  add column if not exists status text not null default 'onboarding',
  add column if not exists project_manager_name text,
  add column if not exists contract_value numeric,
  add column if not exists progress_percent smallint not null default 0,
  add column if not exists due_date date,
  add column if not exists updated_by_id text,
  add column if not exists updated_by_name text,
  add column if not exists cover_photo_url text;

-- One-time backfill for rows that existed before this migration ran.
-- Only touches rows still on the just-added default ('onboarding') so it's
-- safe to re-run without clobbering anything staff have already set by hand.
update public.projects
set status = case when is_active then 'active' else 'archived' end
where status = 'onboarding';

alter table public.projects
  drop constraint if exists projects_status_check;

alter table public.projects
  add constraint projects_status_check
  check (status in ('active', 'onboarding', 'at_risk', 'on_hold', 'completed', 'archived'));

alter table public.projects
  drop constraint if exists projects_progress_percent_check;

alter table public.projects
  add constraint projects_progress_percent_check
  check (progress_percent between 0 and 100);

create index if not exists projects_status_idx on public.projects (status);
create index if not exists projects_due_date_idx on public.projects (due_date);

-- ============================================================================
-- Storage: PUBLIC bucket for card cover photos. Unlike project-documents
-- (private, signed URLs), covers need to render in a grid of many cards at
-- once, so they get plain public URLs instead — no signed-URL round trip
-- per card. Uploaded from the new "Status & Tracking" wizard step.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('project-covers', 'project-covers', true)
on conflict (id) do nothing;

drop policy if exists "project_covers_bucket_anon_all" on storage.objects;
create policy "project_covers_bucket_anon_all"
on storage.objects
for all
to anon
using (bucket_id = 'project-covers')
with check (bucket_id = 'project-covers');
