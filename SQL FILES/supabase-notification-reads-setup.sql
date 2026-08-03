-- ============================================================================
-- notification_reads — tracks which staff member has read which row in the
-- `notifications` table, so "Mark as read" persists server-side (per staff
-- member, follows them across devices/browsers) instead of the old
-- localStorage-only approach.
--
-- Like the rest of this app, there's no Supabase Auth, so auth.uid() is
-- always null. RLS here is written against the anon role with app-level
-- filtering (staff_user_id is trusted from the client, same as everywhere
-- else in this project) rather than auth.uid().
-- ============================================================================

create table if not exists public.notification_reads (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  staff_user_id uuid not null references public.staff_users(id) on delete cascade,
  read_at timestamptz not null default now(),
  unique (notification_id, staff_user_id)
);

create index if not exists notification_reads_staff_user_id_idx
  on public.notification_reads (staff_user_id);

create index if not exists notification_reads_notification_id_idx
  on public.notification_reads (notification_id);

alter table public.notification_reads enable row level security;

-- The app reads/writes this table with the anon key on behalf of whoever is
-- signed in client-side, so anon needs select + insert. There's no update
-- (a read receipt doesn't change once written) and no need for anon delete.
drop policy if exists "notification_reads_select_anon" on public.notification_reads;
create policy "notification_reads_select_anon"
  on public.notification_reads
  for select
  to anon
  using (true);

drop policy if exists "notification_reads_insert_anon" on public.notification_reads;
create policy "notification_reads_insert_anon"
  on public.notification_reads
  for insert
  to anon
  with check (true);
