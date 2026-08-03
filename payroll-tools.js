/* ============================================================================
   payroll-tools.js — "Set Timesheet Period" card + Accounting Employee
   Dashboard (roster, Add Employee, timesheet detail, approved queue) on
   payroll-tools.html.

   Pay period date helpers (ppParseDate, ppFormatLong, loadPayPeriods,
   getNextPayPeriod, getCurrentPayPeriod, allPayPeriods) now live in
   pay-periods-shared.js, loaded before this file — see that file for docs.

   Uses window.supabaseClient, exposed globally by supabase-auth.js.
   initPayrollToolsCard() is called from payroll-tools.html's updateNavAccess()
   once we know the signed-in staff member actually has Payroll Tools access.
============================================================================ */

let calendarViewDate = new Date(); // month currently shown in the View Calendar popup

const PP_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PP_DAY_NAMES_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/* ------------------------- Next-payday summary ------------------------- */

function renderNextPayday() {
  const el = document.getElementById('nextPaydayValue');
  if (!el) return;
  const next = getNextPayPeriod();
  el.textContent = next ? ppFormatMmDdDay(ppParseDate(next.end_date)) : 'No pay period scheduled yet';
}

async function initPayrollToolsCard() {
  await loadPayPeriods();
  renderNextPayday();
  await initAccountingDashboard();
}

/* -------------------------- Popup outside-click-to-close -------------------------- */
/* ppOpenOverlay/ppCloseOverlay themselves now live in pay-periods-shared.js. */

document.addEventListener('DOMContentLoaded', function () {
  ['payPeriodCalendarOverlay', 'newPayPeriodOverlay', 'addEmployeeOverlay', 'employeeDetailOverlay'].forEach(id => {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) ppCloseOverlay(id);
    });
  });
});

/* ------------------------------- View Calendar popup ------------------------------- */

function openPayPeriodCalendar() {
  const next = getNextPayPeriod();
  const anchor = next ? ppParseDate(next.end_date) : new Date();
  calendarViewDate = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  renderCalendarMonth();
  renderPayPeriodList();
  ppOpenOverlay('payPeriodCalendarOverlay');
}

function shiftCalendarMonth(delta) {
  calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + delta, 1);
  renderCalendarMonth();
}

function renderCalendarMonth() {
  const label = document.getElementById('calendarMonthLabel');
  const grid = document.getElementById('calendarGrid');
  if (!label || !grid) return;

  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  label.textContent = `${PP_MONTH_NAMES[month]} ${year}`;

  const startMarks = new Set(allPayPeriods.map(p => p.start_date));
  const endMarks = new Set(allPayPeriods.map(p => p.end_date));

  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = firstOfMonth.getDay();

  let html = PP_DAY_NAMES_SHORT.map(d => `<div class="pp-day pp-day-heading">${d}</div>`).join('');
  for (let i = 0; i < leadingBlanks; i++) html += `<div class="pp-day pp-day-empty"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isStart = startMarks.has(iso);
    const isEnd = endMarks.has(iso);
    let cls = 'pp-day';
    if (isStart) cls += ' pp-day-start';
    if (isEnd) cls += ' pp-day-end';
    const label = isStart && isEnd ? 'Start &amp; payday' : isStart ? 'Period start' : isEnd ? 'Payday' : '';
    html += `<div class="${cls}"${label ? ` title="${label.replace('&amp;', '&')}"` : ''}><span>${day}</span></div>`;
  }

  grid.innerHTML = html;
}

function renderPayPeriodList() {
  const list = document.getElementById('payPeriodList');
  const empty = document.getElementById('payPeriodListEmpty');
  if (!list) return;

  if (!allPayPeriods.length) {
    list.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  const sorted = [...allPayPeriods].sort((a, b) => ppParseDate(b.start_date) - ppParseDate(a.start_date));

  list.innerHTML = sorted.map(p => `
    <div class="info-item">
      <div>
        <h3>${ppFormatLong(ppParseDate(p.start_date))} &ndash; ${ppFormatLong(ppParseDate(p.end_date))}</h3>
        <p>Payday: ${ppFormatMmDdDay(ppParseDate(p.end_date))}</p>
      </div>
      <button type="button" class="auth-button auth-button--red auth-button--sm" onclick="deletePayPeriod('${p.id}')">Delete</button>
    </div>
  `).join('');
}

async function deletePayPeriod(id) {
  if (!confirm('Delete this pay period? This cannot be undone.')) return;
  const { error } = await supabaseClient.from('pay_periods').delete().eq('id', id);
  if (error) { console.error('Failed to delete pay period:', error); alert('Could not delete that pay period.'); return; }
  await loadPayPeriods();
  renderNextPayday();
  renderCalendarMonth();
  renderPayPeriodList();
}

/* --------------------------- Make a New Pay Period popup --------------------------- */

function openNewPayPeriodModal() {
  document.getElementById('newPayPeriodStart').value = '';
  document.getElementById('newPayPeriodEnd').value = '';
  const msg = document.getElementById('newPayPeriodMsg');
  if (msg) { msg.textContent = ''; msg.className = 'auth-message'; }
  ppOpenOverlay('newPayPeriodOverlay');
}

async function submitNewPayPeriod(event) {
  event.preventDefault();
  const startVal = document.getElementById('newPayPeriodStart').value;
  const endVal = document.getElementById('newPayPeriodEnd').value;
  const msg = document.getElementById('newPayPeriodMsg');

  if (!startVal || !endVal) {
    msg.textContent = 'Both a start and end date are required.';
    msg.className = 'auth-message error';
    return;
  }
  if (endVal < startVal) {
    msg.textContent = 'End date must be on or after the start date.';
    msg.className = 'auth-message error';
    return;
  }

  const { error } = await supabaseClient.from('pay_periods').insert({
    start_date: startVal,
    end_date: endVal,
    created_by: window.currentSupabaseProfile?.id || null
  });

  if (error) {
    console.error('Failed to save pay period:', error);
    msg.textContent = 'Something went wrong saving that pay period.';
    msg.className = 'auth-message error';
    return;
  }

  await loadPayPeriods();
  renderNextPayday();
  ppCloseOverlay('newPayPeriodOverlay');
}

/* ============================================================================
   ACCOUNTING EMPLOYEE DASHBOARD
   Roster (payroll_employees), Add Employee, per-employee timesheet detail
   review, and the Approved Queue. All joins are done client-side against a
   flat staff_users fetch (staffDirectoryById) rather than PostgREST embeds,
   matching how the rest of this app avoids relying on FK-name-dependent
   embed syntax.
============================================================================ */

let staffDirectory = [];              // every staff_users row
let staffDirectoryById = new Map();   // id -> staff_users row
let payrollEmployees = [];            // every payroll_employees row
let currentPeriodTimesheets = [];     // timesheets for the open pay period (sparse — not every employee has one yet)
let approvedQueueTimesheets = [];     // timesheets with status Sent to Accounting / Processed, any period
let approvedQueueHoursByTimesheet = new Map(); // timesheet_id -> total hours
let activeEmployeeDetailId = null;    // payroll_employees.id currently open in the detail modal

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

async function loadStaffDirectory() {
  const { data, error } = await supabaseClient
    .from('staff_users')
    .select('id, full_name, username, manager_id, role, workgroup');
  if (error) { console.error('Failed to load staff directory:', error); staffDirectory = []; staffDirectoryById = new Map(); return; }
  staffDirectory = data || [];
  staffDirectoryById = new Map(staffDirectory.map(s => [s.id, s]));
}

function staffName(staffId) {
  const s = staffDirectoryById.get(staffId);
  return s ? (s.full_name || s.username || 'Unnamed') : '—';
}

async function initAccountingDashboard() {
  await loadStaffDirectory();
  await loadPayrollEmployees();
  await loadCurrentPeriodTimesheets();
  renderEmployeeCards();
  await loadApprovedQueue();
  renderApprovedQueue();
}

/* ------------------------------- Roster loading ------------------------------- */

async function loadPayrollEmployees() {
  const { data, error } = await supabaseClient.from('payroll_employees').select('*');
  if (error) { console.error('Failed to load payroll employees:', error); payrollEmployees = []; return; }
  payrollEmployees = (data || []).sort((a, b) => staffName(a.staff_id).localeCompare(staffName(b.staff_id)));
}

async function loadCurrentPeriodTimesheets() {
  const period = getCurrentPayPeriod();
  if (!period) { currentPeriodTimesheets = []; return; }
  const { data, error } = await supabaseClient
    .from('timesheets')
    .select('*')
    .eq('pay_period_id', period.id);
  if (error) { console.error('Failed to load current period timesheets:', error); currentPeriodTimesheets = []; return; }
  currentPeriodTimesheets = data || [];
}

function timesheetForEmployee(payrollEmployeeId) {
  return currentPeriodTimesheets.find(t => t.payroll_employee_id === payrollEmployeeId) || null;
}

/* ------------------------------- Employee cards ------------------------------- */

function renderEmployeeCards() {
  const grid = document.getElementById('employeeCardGrid');
  const empty = document.getElementById('employeeCardEmpty');
  if (!grid) return;

  if (!payrollEmployees.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  grid.innerHTML = payrollEmployees.map(emp => {
    const staff = staffDirectoryById.get(emp.staff_id);
    const managerName = staff && staff.manager_id ? staffName(staff.manager_id) : '—';
    const ts = timesheetForEmployee(emp.id);
    const status = ts ? ts.status : 'Not Started';
    const rate = emp.hourly_rate != null ? `$${Number(emp.hourly_rate).toFixed(2)}/hr` : 'Rate not set';
    return `
      <div class="employee-card ${emp.active ? '' : 'is-inactive'}" onclick="openEmployeeDetailModal('${emp.id}')">
        <h3>${escapeHtml(staffName(emp.staff_id))}${emp.active ? '' : ' (Inactive)'}</h3>
        <p>${escapeHtml(emp.department || 'No department set')}</p>
        <p>Manager: ${escapeHtml(managerName)}</p>
        <p>${rate}</p>
        ${statusPillHtml(status)}
      </div>
    `;
  }).join('');
}

/* ------------------------------- Add Employee popup ------------------------------- */

async function openAddEmployeeModal() {
  await loadStaffDirectory();
  const existingStaffIds = new Set(payrollEmployees.map(e => e.staff_id));
  const available = staffDirectory.filter(s => !existingStaffIds.has(s.id));

  const select = document.getElementById('addEmployeeStaffSelect');
  if (select) {
    select.innerHTML = available.length
      ? available.map(s => `<option value="${s.id}">${escapeHtml(s.full_name || s.username || 'Unnamed')}</option>`).join('')
      : '<option value="">No staff accounts left to add</option>';
  }

  document.getElementById('addEmployeeDepartment').value = '';
  document.getElementById('addEmployeeRate').value = '';
  document.getElementById('addEmployeeType').value = 'Full-time';
  document.getElementById('addEmployeeOvertimeExempt').checked = false;
  const msg = document.getElementById('addEmployeeMsg');
  if (msg) { msg.textContent = ''; msg.className = 'auth-message'; }

  ppOpenOverlay('addEmployeeOverlay');
}

async function submitAddEmployee(event) {
  event.preventDefault();
  const staffId = document.getElementById('addEmployeeStaffSelect').value;
  const msg = document.getElementById('addEmployeeMsg');

  if (!staffId) { msg.textContent = 'Pick a staff member first.'; msg.className = 'auth-message error'; return; }

  const department = document.getElementById('addEmployeeDepartment').value.trim();
  const rateVal = document.getElementById('addEmployeeRate').value;
  const employmentType = document.getElementById('addEmployeeType').value;
  const overtimeExempt = document.getElementById('addEmployeeOvertimeExempt').checked;

  const { error } = await supabaseClient.from('payroll_employees').insert({
    staff_id: staffId,
    department: department || null,
    hourly_rate: rateVal ? Number(rateVal) : null,
    employment_type: employmentType,
    overtime_exempt: overtimeExempt,
    active: true,
    created_by: window.currentSupabaseProfile?.id || null
  });

  if (error) {
    console.error('Failed to add employee to payroll:', error);
    msg.textContent = 'Something went wrong adding that employee.';
    msg.className = 'auth-message error';
    return;
  }

  ppCloseOverlay('addEmployeeOverlay');
  await loadPayrollEmployees();
  renderEmployeeCards();
}

/* ------------------------------- Employee detail popup ------------------------------- */

async function openEmployeeDetailModal(payrollEmployeeId) {
  activeEmployeeDetailId = payrollEmployeeId;
  const emp = payrollEmployees.find(e => e.id === payrollEmployeeId);
  if (!emp) return;

  document.getElementById('employeeDetailName').textContent = staffName(emp.staff_id);
  const staff = staffDirectoryById.get(emp.staff_id);
  const managerName = staff && staff.manager_id ? staffName(staff.manager_id) : 'No manager assigned';
  document.getElementById('employeeDetailSubtitle').textContent = `Manager: ${managerName} · Added ${emp.date_added}`;

  document.getElementById('editEmployeeDepartment').value = emp.department || '';
  document.getElementById('editEmployeeRate').value = emp.hourly_rate != null ? emp.hourly_rate : '';
  document.getElementById('editEmployeeType').value = emp.employment_type || 'Full-time';
  document.getElementById('editEmployeeOvertimeExempt').checked = !!emp.overtime_exempt;
  document.getElementById('employeeDetailToggleActiveBtn').textContent = emp.active ? 'Deactivate' : 'Reactivate';
  const detailMsg = document.getElementById('employeeDetailMsg');
  if (detailMsg) { detailMsg.textContent = ''; detailMsg.className = 'auth-message'; }

  await renderEmployeeDetailTimesheet(emp);
  ppOpenOverlay('employeeDetailOverlay');
}

async function saveEmployeeDetails(event) {
  event.preventDefault();
  if (!activeEmployeeDetailId) return;
  const msg = document.getElementById('employeeDetailMsg');

  const rateVal = document.getElementById('editEmployeeRate').value;
  const { error } = await supabaseClient.from('payroll_employees').update({
    department: document.getElementById('editEmployeeDepartment').value.trim() || null,
    hourly_rate: rateVal ? Number(rateVal) : null,
    employment_type: document.getElementById('editEmployeeType').value,
    overtime_exempt: document.getElementById('editEmployeeOvertimeExempt').checked
  }).eq('id', activeEmployeeDetailId);

  if (error) {
    console.error('Failed to save employee details:', error);
    if (msg) { msg.textContent = 'Something went wrong saving that.'; msg.className = 'auth-message error'; }
    return;
  }

  if (msg) { msg.textContent = 'Saved.'; msg.className = 'auth-message success'; }
  await loadPayrollEmployees();
  renderEmployeeCards();
}

async function toggleEmployeeActive() {
  if (!activeEmployeeDetailId) return;
  const emp = payrollEmployees.find(e => e.id === activeEmployeeDetailId);
  if (!emp) return;
  const { error } = await supabaseClient.from('payroll_employees')
    .update({ active: !emp.active }).eq('id', activeEmployeeDetailId);
  if (error) { console.error('Failed to toggle active status:', error); return; }
  await loadPayrollEmployees();
  renderEmployeeCards();
  const refreshed = payrollEmployees.find(e => e.id === activeEmployeeDetailId);
  if (refreshed) {
    document.getElementById('employeeDetailToggleActiveBtn').textContent = refreshed.active ? 'Deactivate' : 'Reactivate';
  }
}

async function removeEmployeeFromPayroll() {
  if (!activeEmployeeDetailId) return;
  if (!confirm('Remove this employee from payroll? This also deletes their timesheets, entries, and history. This cannot be undone.')) return;
  const { error } = await supabaseClient.from('payroll_employees').delete().eq('id', activeEmployeeDetailId);
  if (error) { console.error('Failed to remove employee from payroll:', error); alert('Could not remove that employee.'); return; }
  ppCloseOverlay('employeeDetailOverlay');
  await loadPayrollEmployees();
  await loadCurrentPeriodTimesheets();
  renderEmployeeCards();
  await loadApprovedQueue();
  renderApprovedQueue();
}

async function renderEmployeeDetailTimesheet(emp) {
  const period = getCurrentPayPeriod();
  const periodLabelEl = document.getElementById('employeeDetailPeriodLabel');
  const entriesBody = document.getElementById('employeeDetailEntriesBody');
  const entriesEmpty = document.getElementById('employeeDetailEntriesEmpty');
  const totalEl = document.getElementById('employeeDetailTotal');
  const actionsEl = document.getElementById('employeeDetailActions');
  const eventsList = document.getElementById('employeeDetailEvents');
  const eventsEmpty = document.getElementById('employeeDetailEventsEmpty');

  if (!period) {
    if (periodLabelEl) periodLabelEl.textContent = 'No pay period has been created yet.';
    if (entriesBody) entriesBody.innerHTML = '';
    if (entriesEmpty) entriesEmpty.style.display = 'block';
    if (totalEl) totalEl.textContent = '';
    if (actionsEl) actionsEl.innerHTML = '';
    if (eventsList) eventsList.innerHTML = '';
    if (eventsEmpty) eventsEmpty.style.display = 'block';
    return;
  }

  if (periodLabelEl) {
    periodLabelEl.textContent = `${ppFormatLong(ppParseDate(period.start_date))} – ${ppFormatLong(ppParseDate(period.end_date))}`;
  }

  const ts = timesheetForEmployee(emp.id);

  if (!ts) {
    if (entriesBody) entriesBody.innerHTML = '';
    if (entriesEmpty) entriesEmpty.style.display = 'block';
    if (totalEl) totalEl.textContent = 'Status: Not Started';
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
    const buttons = [];
    if (ts.status === 'Sent to Accounting') {
      buttons.push(`<button type="button" class="auth-button auth-button--secondary auth-button--sm" onclick="markTimesheetProcessed('${ts.id}')">Mark Processed</button>`);
    } else if (ts.status === 'Processed') {
      buttons.push(`<button type="button" class="auth-button auth-button--secondary auth-button--sm" onclick="markTimesheetComplete('${ts.id}')">Mark Complete</button>`);
    }
    // Unapprove is available any time after manager approval — including
    // after Accounting has processed or fully completed it — since Coleby
    // confirmed Accounting should be able to send a timesheet back even
    // that late in the workflow.
    if (['Sent to Accounting', 'Processed', 'Complete'].includes(ts.status)) {
      buttons.push(`<button type="button" class="auth-button auth-button--red auth-button--sm" onclick="unapproveTimesheet('${ts.id}')">Unapprove</button>`);
    }
    actionsEl.innerHTML = buttons.length
      ? buttons.join('')
      : `<p class="card-subtitle">This timesheet is still with the employee or their manager — no Accounting action yet.</p>`;
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

async function markTimesheetProcessed(timesheetId) {
  const actorId = window.currentSupabaseProfile?.id || null;
  const { error } = await supabaseClient.from('timesheets').update({
    status: 'Processed', processed_by: actorId, processed_at: new Date().toISOString()
  }).eq('id', timesheetId);
  if (error) { console.error('Failed to mark timesheet processed:', error); alert('Could not update that timesheet.'); return; }

  await supabaseClient.from('timesheet_events').insert({ timesheet_id: timesheetId, event_type: 'processed', actor_id: actorId });

  await refreshAccountingDashboardAfterAction();
}

async function markTimesheetComplete(timesheetId) {
  const actorId = window.currentSupabaseProfile?.id || null;
  const { error } = await supabaseClient.from('timesheets').update({
    status: 'Complete', completed_at: new Date().toISOString()
  }).eq('id', timesheetId);
  if (error) { console.error('Failed to mark timesheet complete:', error); alert('Could not update that timesheet.'); return; }

  await supabaseClient.from('timesheet_events').insert({ timesheet_id: timesheetId, event_type: 'completed', actor_id: actorId });

  // The timesheet's own status update above already succeeded regardless of
  // what happens here, so a PDF failure shouldn't look like the whole action
  // failed — just surface it separately so it's not silently lost.
  try {
    const filePath = await generateFinalPdf(timesheetId);
    if (!filePath) {
      console.warn('generateFinalPdf() did not return a file path — check the console for the underlying error.');
      alert('Timesheet marked complete, but the PDF could not be generated. Check the browser console for details.');
    }
  } catch (pdfError) {
    console.error('generateFinalPdf() threw:', pdfError);
    alert('Timesheet marked complete, but generating the PDF failed. Check the browser console for details.');
  }

  await refreshAccountingDashboardAfterAction();
}

// Accounting can send a timesheet back to the employee for corrections even
// after manager approval — including after it's been Processed or fully
// Complete. Requires a comment (same rule as a manager's rejection) so the
// employee knows what to fix. If a final PDF already exists (timesheet was
// Complete), it gets invalidated first since it reflected numbers that are
// about to change.
async function unapproveTimesheet(timesheetId) {
  const commentEl = document.getElementById('employeeDetailComment');
  const comment = commentEl ? commentEl.value.trim() : '';
  if (!comment) { alert('A comment is required so the employee knows what to fix.'); return; }
  if (!confirm('Send this timesheet back to the employee for corrections? This clears its approval/processing/completion status, and removes its PDF if one was already generated.')) return;

  const actorId = window.currentSupabaseProfile?.id || null;

  await invalidateFinalPdf(timesheetId); // no-op if no final PDF exists yet — see payroll-pdf-stub.js

  const { error } = await supabaseClient.from('timesheets').update({
    status: 'Needs Corrections',
    approved_by: null,
    approved_at: null,
    processed_by: null,
    processed_at: null,
    completed_at: null
  }).eq('id', timesheetId);
  if (error) { console.error('Failed to unapprove timesheet:', error); alert('Could not unapprove that timesheet.'); return; }

  await supabaseClient.from('timesheet_events').insert({
    timesheet_id: timesheetId, event_type: 'rejected', actor_id: actorId, comment: `Unapproved by Accounting: ${comment}`
  });

  if (commentEl) commentEl.value = '';
  await refreshAccountingDashboardAfterAction();
}

async function refreshAccountingDashboardAfterAction() {
  await loadCurrentPeriodTimesheets();
  renderEmployeeCards();
  await loadApprovedQueue();
  renderApprovedQueue();
  if (activeEmployeeDetailId) {
    const emp = payrollEmployees.find(e => e.id === activeEmployeeDetailId);
    if (emp) await renderEmployeeDetailTimesheet(emp);
  }
}

/* ------------------------------- Approved queue ------------------------------- */

function switchDashboardTab(tab) {
  const employeesTab = document.getElementById('dashTabEmployees');
  const queueTab = document.getElementById('dashTabQueue');
  const employeesPanel = document.getElementById('dashPanelEmployees');
  const queuePanel = document.getElementById('dashPanelQueue');
  const showEmployees = tab === 'employees';

  if (employeesTab) employeesTab.classList.toggle('active', showEmployees);
  if (queueTab) queueTab.classList.toggle('active', !showEmployees);
  if (employeesPanel) employeesPanel.style.display = showEmployees ? 'block' : 'none';
  if (queuePanel) queuePanel.style.display = showEmployees ? 'none' : 'block';
}

async function loadApprovedQueue() {
  const { data, error } = await supabaseClient
    .from('timesheets')
    .select('*')
    .in('status', ['Sent to Accounting', 'Processed'])
    .order('approved_at', { ascending: false });
  if (error) { console.error('Failed to load approved queue:', error); approvedQueueTimesheets = []; approvedQueueHoursByTimesheet = new Map(); return; }
  approvedQueueTimesheets = data || [];

  approvedQueueHoursByTimesheet = new Map();
  if (approvedQueueTimesheets.length) {
    const ids = approvedQueueTimesheets.map(t => t.id);
    const { data: entries, error: entriesError } = await supabaseClient
      .from('timesheet_entries')
      .select('timesheet_id, regular_hours, overtime_hours')
      .in('timesheet_id', ids);
    if (entriesError) {
      console.error('Failed to load queue entry totals:', entriesError);
    } else {
      (entries || []).forEach(e => {
        const prior = approvedQueueHoursByTimesheet.get(e.timesheet_id) || 0;
        approvedQueueHoursByTimesheet.set(
          e.timesheet_id,
          prior + Number(e.regular_hours || 0) + Number(e.overtime_hours || 0)
        );
      });
    }
  }
}

function renderApprovedQueue() {
  const body = document.getElementById('approvedQueueBody');
  const empty = document.getElementById('approvedQueueEmpty');
  if (!body) return;

  if (!approvedQueueTimesheets.length) {
    body.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  const periodById = new Map(allPayPeriods.map(p => [p.id, p]));

  body.innerHTML = approvedQueueTimesheets.map(ts => {
    const emp = payrollEmployees.find(e => e.id === ts.payroll_employee_id);
    const employeeName = emp ? staffName(emp.staff_id) : 'Removed employee';
    const period = periodById.get(ts.pay_period_id);
    const periodLabel = period ? `${ppFormatLong(ppParseDate(period.start_date))} – ${ppFormatLong(ppParseDate(period.end_date))}` : '—';
    const totalHours = (approvedQueueHoursByTimesheet.get(ts.id) || 0).toFixed(2);
    const approvalDate = ts.approved_at ? new Date(ts.approved_at).toLocaleDateString() : '—';
    const actionBtn = ts.status === 'Sent to Accounting'
      ? `<button type="button" class="auth-button auth-button--secondary auth-button--sm" onclick="markTimesheetProcessed('${ts.id}')">Mark Processed</button>`
      : `<button type="button" class="auth-button auth-button--secondary auth-button--sm" onclick="markTimesheetComplete('${ts.id}')">Mark Complete</button>`;

    return `
      <tr>
        <td>${escapeHtml(employeeName)}</td>
        <td>${periodLabel}</td>
        <td>${totalHours}</td>
        <td>${approvalDate}</td>
        <td>${statusPillHtml(ts.status)}</td>
        <td>${actionBtn}</td>
      </tr>
    `;
  }).join('');
}
