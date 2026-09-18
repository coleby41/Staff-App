-- ============================================================================
-- Full granular permission system -- replaces workgroup_nav_access's 11 whole-tab
-- grants with one table covering every real action in the app (both the old
-- nav-tab grants AND the ~55 action-level checks previously hardcoded across
-- individual JS files), grouped by category/page for the new Workgroups screen
-- and the per-page right-click permission editor.
--
-- IMPORTANT -- this migration is seeded to reproduce TODAY'S REAL ACCESS EXACTLY.
-- Running this changes nobody's access on day one. Coleby can then loosen/tighten
-- individual permissions per workgroup going forward from the new Workgroups UI.
--
-- Six permissions (project_accounts.*, project_files.*, project_timeline.manage,
-- project_todo.manage) are listed here for documentation/completeness but are
-- NOT governed by workgroup at all -- they're controlled per-project by the
-- existing project_members.role system (project_admin/project_manager/accounting/
-- staff/viewer, see supabase-auth-rearchitecture-schema.sql). Their governed_by
-- column is 'project_role', not 'workgroup', and no workgroup_permissions rows
-- exist for them -- the app's UI shows a note instead of checkboxes for these.
--
-- "Manager" stays a personal staff_users.role attribute, not a workgroup, exactly
-- like today: manager.* and general.view_manage_employees are additionally granted
-- in application code to anyone with role = 'Manager', on top of whatever this
-- table says for their actual workgroup(s). See js/permissions.js.
-- ============================================================================

create table if not exists public.permissions (
  key text primary key,
  category text not null,
  page_label text not null,
  label text not null,
  description text,
  governed_by text not null default 'workgroup' check (governed_by in ('workgroup','project_role')),
  sort_order int not null default 0
);

alter table public.permissions enable row level security;
drop policy if exists "permissions_select_authenticated" on public.permissions;
create policy "permissions_select_authenticated" on public.permissions for select to authenticated using (true);
drop policy if exists "permissions_write_it_superadmin" on public.permissions;
create policy "permissions_write_it_superadmin" on public.permissions for all to authenticated
  using (public.is_workgroup('IT') or public.is_super_admin())
  with check (public.is_workgroup('IT') or public.is_super_admin());

create table if not exists public.workgroup_permissions (
  id uuid primary key default gen_random_uuid(),
  workgroup_id uuid not null references public.workgroups(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  unique (workgroup_id, permission_key)
);
create index if not exists workgroup_permissions_workgroup_id_idx on public.workgroup_permissions (workgroup_id);
create index if not exists workgroup_permissions_permission_key_idx on public.workgroup_permissions (permission_key);

alter table public.workgroup_permissions enable row level security;
drop policy if exists "workgroup_permissions_select_authenticated" on public.workgroup_permissions;
create policy "workgroup_permissions_select_authenticated" on public.workgroup_permissions for select to authenticated using (true);
drop policy if exists "workgroup_permissions_write_it_superadmin" on public.workgroup_permissions;
create policy "workgroup_permissions_write_it_superadmin" on public.workgroup_permissions for all to authenticated
  using (public.is_workgroup('IT') or public.is_super_admin())
  with check (public.is_workgroup('IT') or public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Seed permission catalog
-- ---------------------------------------------------------------------------
insert into public.permissions (key, category, page_label, label, description, governed_by, sort_order) values
  ('general.view_dashboard', 'General Access', 'Dashboard', 'View Dashboard', 'See the dashboard tab and its widgets', 'workgroup', 0),
  ('general.view_excel_workbook_templates', 'General Access', 'Excel Workbook Templates', 'View Excel Workbook Templates', 'See and open the Excel Workbook Templates library', 'workgroup', 1),
  ('general.view_form_templates', 'General Access', 'Form Templates', 'View Form Templates', 'See the Form Templates tab', 'workgroup', 2),
  ('general.view_personal_finance', 'General Access', 'Personal Finance (Timesheet)', 'View Personal Finance', 'Every staff member''s own clock-in / timesheet tab', 'workgroup', 3),
  ('general.view_vendor_contacts', 'General Access', 'Vendor Contacts', 'View Vendor Contacts', 'See the Vendors tab', 'workgroup', 4),
  ('general.view_project_overview', 'General Access', 'Project Overview', 'View Project Overview', 'See the Projects tab and open project pages', 'workgroup', 5),
  ('general.view_payroll_tools', 'General Access', 'Payroll Tools', 'View Payroll Tools', 'See the Payroll Tools tab', 'workgroup', 6),
  ('general.view_manage_employees', 'General Access', 'Manage Employees', 'View Manage Employees', 'See the Manage Employees tab. Also auto-granted to anyone whose employee role is set to Manager, regardless of workgroup.', 'workgroup', 7),
  ('general.create_staff_account', 'General Access', 'Create Account', 'Create Staff Account', 'See the Create Account admin link and use the account-creation form', 'workgroup', 8),
  ('general.view_staff_users', 'General Access', 'Staff Users', 'View Staff Users', 'See the Staff Users directory tab', 'workgroup', 9),
  ('general.manage_workgroups', 'General Access', 'Workgroups', 'Manage Workgroups & Permissions', 'See and use the Workgroups (Roles & Permissions) admin screen — editing this screen itself. Not governed by its own grid: Super Admin and IT always keep this, so nobody can edit their way out.', 'workgroup', 10),
  ('vendors.add_edit_vendor', 'Vendors & Companies', 'Vendor Contacts', 'Add / Edit Vendor Info', 'Create a new vendor or edit an existing one''s details', 'workgroup', 11),
  ('vendors.delete_vendor', 'Vendors & Companies', 'Vendor Contacts', 'Delete Vendor', 'Permanently delete a vendor (type-to-confirm)', 'workgroup', 12),
  ('vendors.upload_w9', 'Vendors & Companies', 'Vendor Contacts', 'Upload / Replace W9', 'Upload or replace a vendor''s W9 file', 'workgroup', 13),
  ('vendors.upload_coi', 'Vendors & Companies', 'Vendor Contacts', 'Upload / Replace COI', 'Upload or replace a vendor''s Certificate of Insurance', 'workgroup', 14),
  ('vendors.manage_tags', 'Vendors & Companies', 'Vendor Contacts', 'Manage Vendor Tags & Categories', 'Add, rename, or delete vendor tags and tag categories app-wide', 'workgroup', 15),
  ('vendors.manage_contacts', 'Vendors & Companies', 'Vendor Contacts', 'Manage Vendor Contacts', 'Add, edit, or delete a contact person on a vendor', 'workgroup', 16),
  ('vendors.save_notes', 'Vendors & Companies', 'Vendor Contacts', 'Save Vendor Notes', 'Edit the free-text Notes field on a vendor''s profile', 'workgroup', 17),
  ('vendors.generate_reports', 'Vendors & Companies', 'Vendor Contacts', 'Generate Vendor Reports', 'Build the Approval Status / Specialty PDF reports', 'workgroup', 18),
  ('vendors.manage_coi_notifications', 'Vendors & Companies', 'Vendor Contacts', 'Manage COI Notification Recipients', 'Edit who receives the 60/30/7-day/expired COI email digests', 'workgroup', 19),
  ('workbooks.add', 'Excel Workbook Library', 'Excel Workbook Templates', 'Add Workbook', 'Upload a new Excel workbook template', 'workgroup', 20),
  ('workbooks.edit', 'Excel Workbook Library', 'Excel Workbook Templates', 'Edit Workbook', 'Replace an existing workbook''s file, title, or cover', 'workgroup', 21),
  ('workbooks.delete', 'Excel Workbook Library', 'Excel Workbook Templates', 'Delete Workbook', 'Permanently delete a workbook template (type-to-confirm)', 'workgroup', 22),
  ('forms.fill_out', 'Form Templates', 'Form Templates', 'Fill Out / Submit a Form', 'Fill out and submit any published form', 'workgroup', 23),
  ('forms.create_template', 'Form Templates', 'Form Templates', 'Create New Form Template', 'Use the + New Form button (drag-and-drop or PDF-based builder)', 'workgroup', 24),
  ('forms.edit_any_template', 'Form Templates', 'Form Templates', 'Edit Any Form Template', 'Edit a form template you didn''t create yourself', 'workgroup', 25),
  ('forms.delete_template', 'Form Templates', 'Form Templates', 'Delete Form Template', 'Permanently delete a form template (type-to-confirm)', 'workgroup', 26),
  ('forms.manage_responses', 'Form Templates', 'Form Templates', 'View & Manage Form Responses', 'View, edit, delete, or bulk-download a form''s submitted responses', 'workgroup', 27),
  ('projects.create', 'Projects', 'Project Overview', 'Create New Project', 'Use the New Project button and onboarding wizard', 'workgroup', 28),
  ('projects.edit', 'Projects', 'Project Overview', 'Edit Project Details', 'Use Quick Edit and the full wizard on an existing project', 'workgroup', 29),
  ('projects.delete', 'Projects', 'Project Overview', 'Delete Project', 'Permanently delete a project (type-to-confirm)', 'workgroup', 30),
  ('project_accounts.manage_all', 'Project Sub-Pages (per-project role)', 'Project Accounts & Contacts', 'Manage All Project Accounts & Contacts', 'Add/edit/delete any Contacts/Organizations/Utility Accounts/Gov Offices record on a project', 'project_role', 31),
  ('project_accounts.edit_own', 'Project Sub-Pages (per-project role)', 'Project Accounts & Contacts', 'Edit Own Created Records', 'Edit/delete a record you personally created, without the role above', 'project_role', 32),
  ('project_files.upload', 'Project Sub-Pages (per-project role)', 'Project Files', 'Upload Files', 'Upload files into any category/subfolder of a project', 'project_role', 33),
  ('project_files.manage_all', 'Project Sub-Pages (per-project role)', 'Project Files', 'Manage All Project Files', 'Rename or delete a file someone else uploaded', 'project_role', 34),
  ('project_files.rename_delete_own', 'Project Sub-Pages (per-project role)', 'Project Files', 'Rename / Delete Own Uploaded Files', 'Rename/delete a file you uploaded, without the role above', 'project_role', 35),
  ('project_timeline.manage', 'Project Sub-Pages (per-project role)', 'Project Timeline', 'Manage Project Timeline', 'Create/edit/delete Gantt tasks and phases, reorder, set dependencies', 'project_role', 36),
  ('project_todo.manage', 'Project Sub-Pages (per-project role)', 'Project To-Do', 'Manage Project To-Do', 'Create/delete to-do items, reassign/edit subitems, mark anything complete', 'project_role', 37),
  ('timesheet.submit_own', 'Payroll & Timesheets', 'Personal Finance (Timesheet)', 'Submit Own Timesheet', 'Save a draft / submit your own timesheet for the pay period', 'workgroup', 38),
  ('timesheet.manage_own_documents', 'Payroll & Timesheets', 'Personal Finance (Timesheet)', 'Manage Own Timesheet Documents', 'Upload/delete your own supporting documents', 'workgroup', 39),
  ('manager.view_team_timesheets', 'Payroll & Timesheets', 'Manage Employees', 'View Team Timesheets', 'See direct reports'' submitted timesheets. Also auto-granted to anyone whose employee role is Manager.', 'workgroup', 40),
  ('manager.approve_reject_timesheets', 'Payroll & Timesheets', 'Manage Employees', 'Approve / Reject Timesheets', 'The manager review step, with a required comment on reject. Also auto-granted to Manager role.', 'workgroup', 41),
  ('manager.comment_on_timesheet', 'Payroll & Timesheets', 'Manage Employees', 'Comment on a Timesheet', 'Add a note without approving/rejecting. Also auto-granted to Manager role.', 'workgroup', 42),
  ('payroll.manage_pay_periods', 'Payroll & Timesheets', 'Payroll Tools', 'Manage Pay Periods', 'Create a new pay period, or delete one', 'workgroup', 43),
  ('payroll.post_announcement', 'Payroll & Timesheets', 'Payroll Tools', 'Post Company Announcement', 'Post the banner every employee sees on their timesheet page', 'workgroup', 44),
  ('payroll.add_remove_employee', 'Payroll & Timesheets', 'Payroll Tools', 'Add / Remove Payroll Employee', 'Add someone to the payroll roster, or take them off it', 'workgroup', 45),
  ('payroll.edit_employee_details', 'Payroll & Timesheets', 'Payroll Tools', 'Edit Payroll Employee Details', 'Pay-rate/employee-record fields, activate/deactivate', 'workgroup', 46),
  ('payroll.unapprove_timesheet', 'Payroll & Timesheets', 'Payroll Tools', 'Send Approved Timesheet Back', 'Accounting''s override, even after processed/complete; requires a comment', 'workgroup', 47),
  ('payroll.mark_processed_complete', 'Payroll & Timesheets', 'Payroll Tools', 'Mark Timesheet Processed / Complete', 'The two final-status transitions in the payroll pipeline', 'workgroup', 48),
  ('incident_reports.submit', 'Incident Reports', 'Incident Report', 'Submit Incident Report', 'Fill out and file a new incident report', 'workgroup', 49),
  ('incident_reports.edit_own', 'Incident Reports', 'Incident Report', 'Edit Own Submitted Report', 'Edit a report you filed, via its edit link', 'workgroup', 50),
  ('incident_reports.set_default_approver', 'Incident Reports', 'Incident Report', 'Set Default Approver', 'Choose who the "needs review" notification goes to', 'workgroup', 51),
  ('incident_reports.view_all_activity', 'Incident Reports', 'Account Activity', 'View All Incident Reports & Activity', 'The Account Activity dashboard -- every staff member''s reports and project activity', 'workgroup', 52),
  ('incident_reports.approve', 'Incident Reports', 'Account Activity', 'Approve Incident Report', 'Approve a report, auto-merging and filing the final PDF into the project', 'workgroup', 53),
  ('incident_reports.reject', 'Incident Reports', 'Account Activity', 'Reject Incident Report', 'Reject with a required reason, notifies the submitter', 'workgroup', 54),
  ('incident_reports.retry_filing', 'Incident Reports', 'Account Activity', 'Retry Filing an Approved Report', 'Re-run the PDF merge/file step if it failed the first time', 'workgroup', 55),
  ('incident_reports.delete_filed_report', 'Incident Reports', 'Account Activity', 'Delete a Filed Report', 'Remove a report record entirely', 'workgroup', 56),
  ('staff.edit_account_details', 'Staff Accounts & Directory', 'Staff Users', 'Edit Staff Account Details', 'Name, username, workgroup(s), role, manager, employee code, notes', 'workgroup', 57),
  ('staff.reset_password', 'Staff Accounts & Directory', 'Staff Users', 'Reset Staff Password', 'Reset a staff member''s password via the reset-staff-password function', 'workgroup', 58)
on conflict (key) do update set
  category = excluded.category, page_label = excluded.page_label, label = excluded.label,
  description = excluded.description, governed_by = excluded.governed_by, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Seed grants -- reproduces today's real access exactly, per workgroup name
-- ---------------------------------------------------------------------------
do $$
declare
  wg record;
begin
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.view_dashboard' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.view_excel_workbook_templates' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.view_form_templates' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.view_personal_finance' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.view_vendor_contacts' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.view_project_overview' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.view_payroll_tools' from public.workgroups where name in ('Office', 'Accounting', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.view_manage_employees' from public.workgroups where name in ('Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.create_staff_account' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.view_staff_users' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'general.manage_workgroups' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'vendors.add_edit_vendor' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'vendors.delete_vendor' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'vendors.upload_w9' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'vendors.upload_coi' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'vendors.manage_tags' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'vendors.manage_contacts' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'vendors.save_notes' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'vendors.generate_reports' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'vendors.manage_coi_notifications' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'workbooks.add' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'workbooks.edit' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'workbooks.delete' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'forms.fill_out' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'forms.create_template' from public.workgroups where name in ('IT', 'Office', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'forms.edit_any_template' from public.workgroups where name in ('IT', 'Office', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'forms.delete_template' from public.workgroups where name in ('IT', 'Office', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'forms.manage_responses' from public.workgroups where name in ('IT', 'Office', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'projects.create' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'projects.edit' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'projects.delete' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'timesheet.submit_own' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'timesheet.manage_own_documents' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'manager.view_team_timesheets' from public.workgroups where name in ('Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'manager.approve_reject_timesheets' from public.workgroups where name in ('Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'manager.comment_on_timesheet' from public.workgroups where name in ('Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'payroll.manage_pay_periods' from public.workgroups where name in ('Office', 'Accounting', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'payroll.post_announcement' from public.workgroups where name in ('Office', 'Accounting', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'payroll.add_remove_employee' from public.workgroups where name in ('Office', 'Accounting', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'payroll.edit_employee_details' from public.workgroups where name in ('Office', 'Accounting', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'payroll.unapprove_timesheet' from public.workgroups where name in ('Office', 'Accounting', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'payroll.mark_processed_complete' from public.workgroups where name in ('Office', 'Accounting', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'incident_reports.submit' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'incident_reports.edit_own' from public.workgroups where name in ('Owner', 'Field', 'IT', 'Office', 'Accounting', 'Super Admin', 'Operations')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'incident_reports.set_default_approver' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'incident_reports.view_all_activity' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'incident_reports.approve' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'incident_reports.reject' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'incident_reports.retry_filing' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'incident_reports.delete_filed_report' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'staff.edit_account_details' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
  insert into public.workgroup_permissions (workgroup_id, permission_key)
  select id, 'staff.reset_password' from public.workgroups where name in ('IT', 'Super Admin')
  on conflict (workgroup_id, permission_key) do nothing;
end $$;

