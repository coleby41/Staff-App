-- One-time cleanup: The Look Salon Suites has two leftover phases —
-- "Site Clean" (with a "Foundation" task dated Nov 2026) and "Walls Up"
-- (with a "Testing" task dated Jul 2028) — that are bad/placeholder data,
-- not real project data. The Jul 2028 date is what was driving that
-- project's "554 days late" banner. Run this once in the Supabase SQL
-- Editor to remove them. Scoped tightly by project name + exact phase
-- names, so it can't touch any other project even if another project
-- happens to reuse one of those phase names.
--
-- Safe to re-run: if the phases are already gone, it just reports
-- "nothing to delete" and does nothing.

do $$
declare
  v_project_id uuid;
  v_phase_ids uuid[];
  v_task_count int;
  v_phase_count int;
begin
  select id into v_project_id
  from public.projects
  where name = 'The Look Salon Suites';

  if v_project_id is null then
    raise exception 'No project named "The Look Salon Suites" found -- aborting, nothing deleted. (If the project has since been renamed, update the name in this script and re-run.)';
  end if;

  select array_agg(id) into v_phase_ids
  from public.schedule_phases
  where project_id = v_project_id
    and name in ('Site Clean', 'Walls Up');

  if v_phase_ids is null or array_length(v_phase_ids, 1) = 0 then
    raise notice 'No "Site Clean"/"Walls Up" phases found on this project -- nothing to delete.';
    return;
  end if;

  -- schedule_dependencies rows referencing these tasks are removed
  -- automatically (predecessor_task_id/successor_task_id are both
  -- "on delete cascade"). schedule_tasks.phase_id is "on delete restrict",
  -- so tasks/milestones under these phases have to go first.
  delete from public.schedule_tasks
  where phase_id = any(v_phase_ids);
  get diagnostics v_task_count = row_count;

  v_phase_count := array_length(v_phase_ids, 1);
  delete from public.schedule_phases
  where id = any(v_phase_ids);

  raise notice 'Deleted % phase(s) and % task(s)/milestone(s) from "The Look Salon Suites".', v_phase_count, v_task_count;
end $$;
