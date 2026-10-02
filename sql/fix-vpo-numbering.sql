-- ============================================================================
-- Fix: VPO numbering restarted at 1 after "Submit Old Forms" imports
-- (2026-10-02)
-- ============================================================================
-- Problem: imported old VPOs keep their original number (e.g. VPO-HC-1-6-54)
-- but never touched vpo_building_counters / vpo_project_counters, so the
-- first real VPO afterward came out as VPO-HC-1-1-1 instead of VPO-HC-1-7-56.
--
-- Fix: next_vpo_numbering() now looks at every existing VPO on the project,
-- including imported ones (their numbers are parsed from vpo_number since
-- building_seq/project_total_at_creation are null on those), and always
-- issues one past the highest it finds. Then a one-time block renumbers the
-- VPOs that were already created with the wrong numbers.
--
-- Run this whole file once in the Supabase SQL editor.
-- ============================================================================


-- ---- 1. Numbering function -------------------------------------------------
create or replace function public.next_vpo_numbering(p_project_id uuid, p_building_number text)
returns table (building_seq integer, project_total integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  -- VPO-<code>-<building>-<building seq>-<project total>
  v_pat constant text := '^VPO-[^-]+-([^-]+)-([0-9]+)-([0-9]+)$';
  v_max_seq integer;
  v_max_total integer;
  v_counter_seq integer;
  v_counter_total integer;
  v_building_seq integer;
  v_project_total integer;
begin
  -- One numbering call at a time per project, so two people creating a VPO
  -- at the same moment can't both get the same number.
  perform pg_advisory_xact_lock(hashtext('vpo_numbering:' || p_project_id::text));

  -- Highest building seq already used for this building (real + imported).
  select coalesce(max(coalesce(v.building_seq, (regexp_match(v.vpo_number, v_pat))[2]::int)), 0)
    into v_max_seq
    from public.vpos v
   where v.project_id = p_project_id
     and coalesce((regexp_match(v.vpo_number, v_pat))[1], v.building_number) = p_building_number;

  -- Highest project total already used on this project (real + imported).
  select coalesce(max(coalesce(v.project_total_at_creation, (regexp_match(v.vpo_number, v_pat))[3]::int)), 0)
    into v_max_total
    from public.vpos v
   where v.project_id = p_project_id;

  -- Still respect the counters too (they only ever hold back a number
  -- that's above everything currently in the table, e.g. after a non-top delete).
  select c.next_number - 1 into v_counter_seq
    from public.vpo_building_counters c
   where c.project_id = p_project_id and c.building_number = p_building_number;

  select c.total_count into v_counter_total
    from public.vpo_project_counters c
   where c.project_id = p_project_id;

  v_building_seq  := greatest(v_max_seq,   coalesce(v_counter_seq, 0))   + 1;
  v_project_total := greatest(v_max_total, coalesce(v_counter_total, 0)) + 1;

  -- Keep the counters in sync so the delete/reclaim trigger keeps working.
  insert into public.vpo_building_counters (project_id, building_number, next_number)
  values (p_project_id, p_building_number, v_building_seq + 1)
  on conflict (project_id, building_number) do update set next_number = excluded.next_number;

  insert into public.vpo_project_counters (project_id, total_count)
  values (p_project_id, v_project_total)
  on conflict (project_id) do update set total_count = excluded.total_count;

  building_seq := v_building_seq;
  project_total := v_project_total;
  return next;
end;
$$;


-- ---- 2. One-time: renumber VPOs that were issued wrong ---------------------
-- Every app-created VPO (project_total_at_creation is set; imported ones
-- have it null) is renumbered in creation order on top of the imported ones.
-- Also renames the filed document in project_files to match.
-- NOTE: the text INSIDE an already-filed .docx still shows the old number.
do $$
declare
  r record;
  n record;
  v_new text;
begin
  create temp table _vpo_fix as
    select id, project_id, building_number, vpo_number as old_number,
           split_part(vpo_number, '-', 2) as code, project_file_id, created_at
      from public.vpos
     where project_total_at_creation is not null;

  -- Clear them first so they don't count toward the "highest used" numbers.
  update public.vpos
     set vpo_number = null, building_seq = null, project_total_at_creation = null
   where id in (select id from _vpo_fix);

  delete from public.vpo_building_counters where project_id in (select project_id from _vpo_fix);
  delete from public.vpo_project_counters  where project_id in (select project_id from _vpo_fix);

  for r in select * from _vpo_fix order by created_at loop
    select * into n from public.next_vpo_numbering(r.project_id, r.building_number);
    v_new := 'VPO-' || r.code || '-' || r.building_number || '-' || n.building_seq || '-' || n.project_total;

    update public.vpos
       set vpo_number = v_new,
           building_seq = n.building_seq,
           project_total_at_creation = n.project_total
     where id = r.id;

    if r.project_file_id is not null then
      update public.project_files
         set file_name = replace(file_name, r.old_number, v_new)
       where id = r.project_file_id;
    end if;

    raise notice '% -> %', r.old_number, v_new;
  end loop;

  drop table _vpo_fix;
end $$;


-- ---- Sanity check ----------------------------------------------------------
-- New VPOs should now sit above the imported ones (expect VPO-HC-1-7-56 etc.):
--   select vpo_number, building_seq, project_total_at_creation, created_at
--     from public.vpos order by created_at;
