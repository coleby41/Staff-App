/* ============================================================================
   payroll-tools.js — "Set Timesheet Period" card on payroll-tools.html

   Reads/writes public.pay_periods (see supabase-pay-periods-setup.sql).
   Each row is one accounting-created pay period: an explicit start_date and
   end_date. "Next payday" is the end_date of the soonest period that hasn't
   ended yet. Replaces the old localStorage anchor-Thursday/biweekly-math
   approach, which is now removed from payroll-tools.html.

   Uses window.supabaseClient, exposed globally by supabase-auth.js.
   initPayrollToolsCard() is called from payroll-tools.html's updateNavAccess()
   once we know the signed-in staff member actually has Payroll Tools access.
============================================================================ */

let allPayPeriods = [];       // every row from pay_periods, loaded by loadPayPeriods()
let calendarViewDate = new Date(); // month currently shown in the View Calendar popup

const PP_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PP_DAY_NAMES_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function ppStripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// pay_periods.start_date / end_date come back as "YYYY-MM-DD" — parse as
// local calendar dates, not UTC, so the displayed weekday never shifts.
function ppParseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function ppFormatMmDdDay(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
  return `${mm}/${dd}, ${dayName}`;
}

function ppFormatLong(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ------------------------- Load + next-payday summary ------------------------- */

async function loadPayPeriods() {
  const { data, error } = await supabaseClient
    .from('pay_periods')
    .select('*')
    .order('start_date', { ascending: true });
  if (error) { console.error('Failed to load pay periods:', error); allPayPeriods = []; return; }
  allPayPeriods = data || [];
}

function getNextPayPeriod() {
  const today = ppStripTime(new Date());
  const upcoming = allPayPeriods
    .filter(p => ppStripTime(ppParseDate(p.end_date)) >= today)
    .sort((a, b) => ppParseDate(a.end_date) - ppParseDate(b.end_date));
  return upcoming[0] || null;
}

function renderNextPayday() {
  const el = document.getElementById('nextPaydayValue');
  if (!el) return;
  const next = getNextPayPeriod();
  el.textContent = next ? ppFormatMmDdDay(ppParseDate(next.end_date)) : 'No pay period scheduled yet';
}

async function initPayrollToolsCard() {
  await loadPayPeriods();
  renderNextPayday();
}

/* --------------------------------- Popup plumbing --------------------------------- */

function ppOpenOverlay(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.remove('hidden');
  document.body.classList.add('popup-active');
}

function ppCloseOverlay(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.add('hidden');
  document.body.classList.remove('popup-active');
}

document.addEventListener('DOMContentLoaded', function () {
  ['payPeriodCalendarOverlay', 'newPayPeriodOverlay'].forEach(id => {
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
