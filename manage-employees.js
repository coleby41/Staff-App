/* ============================================================================
   manage-employees.js — Manager Portal (manage-employees.html)

   Shows a manager only their direct reports (staff_users.manager_id === me)
   who are also on payroll (have a payroll_employees row), lets them review
   the current pay period's timesheet, approve (-> status 'Sent to
   Accounting', which is also how it's recorded as "Approved by Manager" —
   see supabase-timesheet-workflow-setup.sql for why those are one status),
   reject with a required comment (-> status 'Needs Corrections', reopening
   it for the employee to fix and resubmit), or leave a standalone comment.

   Pay period helpers + ppOpenOverlay/ppCloseOverlay come from
   pay-periods-shared.js, loaded before this file.

   Uses window.supabaseClient, exposed globally by supabase-auth.js.
============================================================================ */

let managerProfile = null;
let staffDirectory = [];            // every staff_users row (small app — fine to fetch in full)
let staffDirectoryById = new Map();
let myTeam = [];                    // payroll_employees rows for staff whose manager_id === me
let teamTimesheets = [];            // current-period timesheets for myTeam
let activeReviewTimesheetId = null;
let activeReviewEmployeeId = null;  // payroll_employees.id

function staffName(staffId) {
  const s = staffDirectoryById.get(staffId);
  return s ? (s.full_name || s.username || 'Unnamed') : '—';
}

const STATUS_PILL_CLASS = {
  'Not Started': 'ts-not-started',
  'In Progress': 'ts-in-progress',
  'Submitted': 'ts-submitted',
  'Needs Corrections': 'ts-needs-corrections',
  'Sent to Accounting': 'ts-sent-to-accounting',
  'Processed': 'ts-processed',
  'Complete': 'ts-complete'
};

function statusPillHtml(status) {
  const cls = STATUS_PILL_CLASS[status] || 'ts-not-started';
  return `<span class="status ${cls}">${escapeHtml(status || 'Not Started')}</span>`;
}

async function initManagerPortal(profile) {
  managerProfile = profile;
  await loadPayPeriods();
  await loadStaffDirectory();
  await loadTeam();
  await loadTeamTimesheets();
  renderTeamPeriodLabel();
  renderTeamCards();
}

async function loadStaffDirectory() {
  const { data, error } = await supabaseClient
    .from('staff_users')
    .select('id, full_name, username, manager_id, role');
  if (error) { console.error('Failed to load staff directory:', error); staffDirectory = []; staffDirectoryById = new Map(); return; }
  staffDirectory = data || [];
  staffDirectoryById = new Map(staffDirectory.map(s => [s.id, s]));
}

async function loadTeam() {
  const myId = managerProfile?.id;
  if (!myId) { myTeam = []; return; }
  const reportIds = staffDirectory.filter(s => s.manager_id === myId).map(s => s.id);
  if (!reportIds.length) { myTeam = []; return; }

  const { data, error } = await supabaseClient
    .from('payroll_employees')
    .select('*')
    .in('staff_id', reportIds);
  if (error) { console.error('Failed to load team roster:', error); myTeam = []; return; }
  myTeam = (data || []).sort((a, b) => staffName(a.staff_id).localeCompare(staffName(b.staff_id)));
}

async function loadTeamTimesheets() {
  const period = getCurrentPayPeriod();
  if (!period || !myTeam.length) { teamTimesheets = []; return; }
  const employeeIds = myTeam.map(e => e.id);
  const { data, error } = await supabaseClient
    .from('timesheets')
    .select('*')
    .eq('pay_period_id', period.id)
    .in('payroll_employee_id', employeeIds);
  if (error) { console.error('Failed to load team timesheets:', error); teamTimesheets = []; return; }
  teamTimesheets = data || [];
}

function timesheetForTeamEmployee(payrollEmployeeId) {
  return teamTimesheets.find(t => t.payroll_employee_id === payrollEmployeeId) || null;
}

function renderTeamPeriodLabel() {
  const label = document.getElementById('teamPeriodLabel');
  const period = getCurrentPayPeriod();
  if (label) {
    label.textContent = period
      ? `Current pay period: ${ppFormatLong(ppParseDate(period.start_date))} – ${ppFormatLong(ppParseDate(period.end_date))}`
      : 'No pay period has been created yet — check with Accounting.';
  }
}

function renderTeamCards() {
  const grid = document.getElementById('teamCardGrid');
  const empty = document.getElementById('teamCardEmpty');
  const chip = document.getElementById('pendingReviewChip');
  if (!grid) return;

  if (!myTeam.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'block';
    if (chip) chip.textContent = '0 awaiting review';
    return;
  }
  if (empty) empty.style.display = 'none';

  let pendingCount = 0;
  grid.innerHTML = myTeam.map(emp => {
    const ts = timesheetForTeamEmployee(emp.id);
    const status = ts ? ts.status : 'Not Started';
    if (status === 'Submitted') pendingCount++;
    const rate = emp.hourly_rate != null ? `$${Number(emp.hourly_rate).toFixed(2)}/hr` : 'Rate not set';
    return `
      <div class="employee-card ${emp.active ? '' : 'is-inactive'}" onclick="openReviewModal('${emp.id}')">
        <h3>${escapeHtml(staffName(emp.staff_id))}${emp.active ? '' : ' (Inactive)'}</h3>
        <p>${escapeHtml(emp.department || 'No department set')}</p>
        <p>${rate}</p>
        ${statusPillHtml(status)}
      </div>
    `;
  }).join('');

  if (chip) chip.textContent = `${pendingCount} awaiting review`;
}

/* ------------------------------- Review popup ------------------------------- */

async function openReviewModal(payrollEmployeeId) {
  activeReviewEmployeeId = payrollEmployeeId;
  const emp = myTeam.find(e => e.id === payrollEmployeeId);
  if (!emp) return;

  document.getElementById('reviewEmployeeName').textContent = staffName(emp.staff_id);
  const period = getCurrentPayPeriod();
  document.getElementById('reviewPeriodLabel').textContent = period
    ? `${ppFormatLong(ppParseDate(period.start_date))} – ${ppFormatLong(ppParseDate(period.end_date))}`
    : 'No pay period has been created yet.';

  document.getElementById('reviewComment').value = '';
  const msg = document.getElementById('reviewMsg');
  if (msg) { msg.textContent = ''; msg.className = 'auth-message'; }

  await renderReviewTimesheet(emp);
  ppOpenOverlay('reviewTimesheetOverlay');
}

async function renderReviewTimesheet(emp) {
  const entriesBody = document.getElementById('reviewEntriesBody');
  const entriesEmpty = document.getElementById('reviewEntriesEmpty');
  const totalEl = document.getElementById('reviewTotal');
  const actionsEl = document.getElementById('reviewActions');
  const eventsList = document.getElementById('reviewEvents');
  const eventsEmpty = document.getElementById('reviewEventsEmpty');

  const ts = timesheetForTeamEmployee(emp.id);
  activeReviewTimesheetId = ts ? ts.id : null;

  if (!ts) {
    if (entriesBody) entriesBody.innerHTML = '';
    if (entriesEmpty) entriesEmpty.style.display = 'block';
    if (totalEl) totalEl.textContent = 'Status: Not Started — nothing to review yet.';
    if (actionsEl) actionsEl.innerHTML = '';
    if (eventsList) eventsList.innerHTML = '';
    if (eventsEmpty) eventsEmpty.style.display = 'block';
    return;
  }

  const [{ data: entries, error: entriesError }, { data: events, error: eventsError }] = await Promise.all([
    supabaseClient.from('timesheet_entries').select('*').eq('timesheet_id', ts.id).order('work_date', { ascending: true }),
    supabaseClient.from('timesheet_events').select('*').eq('timesheet_id', ts.id).order('created_at', { ascending: false })
  ]);
  if (entriesError) console.error('Failed to load timesheet entries:', entriesError);
  if (eventsError) console.error('Failed to load timesheet events:', eventsError);

  const rows = entries || [];
  if (!rows.length) {
    if (entriesBody) entriesBody.innerHTML = '';
    if (entriesEmpty) entriesEmpty.style.display = 'block';
  } else {
    if (entriesEmpty) entriesEmpty.style.display = 'none';
    if (entriesBody) {
      entriesBody.innerHTML = rows.map(r => `
        <tr>
          <td>${r.work_date}</td>
          <td>${r.clock_in || '—'}</td>
          <td>${r.clock_out || '—'}</td>
          <td>${Number(r.regular_hours || 0).toFixed(2)}</td>
          <td>${Number(r.overtime_hours || 0).toFixed(2)}</td>
          <td>${escapeHtml(r.notes || '')}</td>
        </tr>
      `).join('');
    }
  }

  const totalHours = rows.reduce((sum, r) => sum + Number(r.regular_hours || 0) + Number(r.overtime_hours || 0), 0);
  if (totalEl) totalEl.textContent = `Status: ${ts.status} · Total hours: ${totalHours.toFixed(2)}`;

  if (actionsEl) {
    if (ts.status === 'Submitted' || ts.status === 'Needs Corrections') {
      actionsEl.innerHTML = `
        <button type="button" class="auth-button auth-button--red auth-button--sm" onclick="rejectTimesheet()">Reject (needs corrections)</button>
        <button type="button" class="auth-button auth-button--secondary auth-button--sm" onclick="approveTimesheet()">Approve</button>
      `;
    } else if (ts.status === 'Not Started' || ts.status === 'In Progress') {
      actionsEl.innerHTML = `<p class="card-subtitle">Still with the employee — nothing to approve yet.</p>`;
    } else {
      actionsEl.innerHTML = `<p class="card-subtitle">Already handled — this is now with Accounting.</p>`;
    }
  }

  const eventRows = events || [];
  if (!eventRows.length) {
    if (eventsList) eventsList.innerHTML = '';
    if (eventsEmpty) eventsEmpty.style.display = 'block';
  } else {
    if (eventsEmpty) eventsEmpty.style.display = 'none';
    if (eventsList) {
      eventsList.innerHTML = eventRows.map(ev => `
        <div class="info-item">
          <div>
            <h3>${escapeHtml(eventTypeLabel(ev.event_type))} — ${escapeHtml(staffName(ev.actor_id))}</h3>
            ${ev.comment ? `<p>${escapeHtml(ev.comment)}</p>` : ''}
            <p>${new Date(ev.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
          </div>
        </div>
      `).join('');
    }
  }
}

function eventTypeLabel(type) {
  const labels = {
    submitted: 'Submitted',
    approved: 'Approved by manager',
    rejected: 'Sent back for corrections',
    comment: 'Comment',
    sent_to_accounting: 'Sent to Accounting',
    processed: 'Marked processed',
    completed: 'Marked complete'
  };
  return labels[type] || type;
}

async function approveTimesheet() {
  if (!activeReviewTimesheetId) return;
  const actorId = managerProfile?.id || null;
  const comment = document.getElementById('reviewComment').value.trim();

  const { error } = await supabaseClient.from('timesheets').update({
    status: 'Sent to Accounting',
    approved_by: actorId,
    approved_at: new Date().toISOString()
  }).eq('id', activeReviewTimesheetId);

  if (error) {
    console.error('Failed to approve timesheet:', error);
    setReviewMessage('Something went wrong approving that.', 'error');
    return;
  }

  await supabaseClient.from('timesheet_events').insert({
    timesheet_id: activeReviewTimesheetId, event_type: 'approved', actor_id: actorId, comment: comment || null
  });

  // TODO(Excel/PDF integration): once the payroll workbook is provided, this
  // is a reasonable hook point to kick off populating it for Accounting.

  setReviewMessage('Approved — sent to Accounting.', 'success');
  await refreshTeamAfterAction();
}

async function rejectTimesheet() {
  if (!activeReviewTimesheetId) return;
  const comment = document.getElementById('reviewComment').value.trim();
  if (!comment) { setReviewMessage('A comment is required so the employee knows what to fix.', 'error'); return; }

  const actorId = managerProfile?.id || null;
  const { error } = await supabaseClient.from('timesheets').update({
    status: 'Needs Corrections'
  }).eq('id', activeReviewTimesheetId);

  if (error) {
    console.error('Failed to reject timesheet:', error);
    setReviewMessage('Something went wrong rejecting that.', 'error');
    return;
  }

  await supabaseClient.from('timesheet_events').insert({
    timesheet_id: activeReviewTimesheetId, event_type: 'rejected', actor_id: actorId, comment
  });

  setReviewMessage('Sent back to the employee for corrections.', 'success');
  await refreshTeamAfterAction();
}

async function addManagerComment() {
  if (!activeReviewTimesheetId) { setReviewMessage('Nothing to comment on yet — this employee hasn\'t started a timesheet.', 'error'); return; }
  const comment = document.getElementById('reviewComment').value.trim();
  if (!comment) { setReviewMessage('Write a comment first.', 'error'); return; }

  const { error } = await supabaseClient.from('timesheet_events').insert({
    timesheet_id: activeReviewTimesheetId, event_type: 'comment', actor_id: managerProfile?.id || null, comment
  });
  if (error) { console.error('Failed to add comment:', error); setReviewMessage('Something went wrong posting that comment.', 'error'); return; }

  document.getElementById('reviewComment').value = '';
  setReviewMessage('Comment added.', 'success');
  const emp = myTeam.find(e => e.id === activeReviewEmployeeId);
  if (emp) await renderReviewTimesheet(emp);
}

function setReviewMessage(text, type) {
  const msg = document.getElementById('reviewMsg');
  if (!msg) return;
  msg.textContent = text;
  msg.className = `auth-message ${type}`;
}

async function refreshTeamAfterAction() {
  await loadTeamTimesheets();
  renderTeamCards();
  const emp = myTeam.find(e => e.id === activeReviewEmployeeId);
  if (emp) await renderReviewTimesheet(emp);
}

document.addEventListener('DOMContentLoaded', function () {
  const overlay = document.getElementById('reviewTimesheetOverlay');
  if (overlay) {
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) ppCloseOverlay('reviewTimesheetOverlay');
    });
  }
});
