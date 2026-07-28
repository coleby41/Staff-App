/* ============================================================================
   pay-periods-shared.js — shared date helpers + Supabase reads for
   public.pay_periods (see supabase-pay-periods-setup.sql).

   Used by payroll-tools.js (Set Timesheet Period card), timesheet.js
   (Personal Finance timesheet entry), and manage-employees.js (Manager
   portal) so none of them duplicate this logic.

   Load this after supabase-config.js/supabase-auth.js and before any script
   that calls these functions.
============================================================================ */

let allPayPeriods = []; // every row from pay_periods, refreshed by loadPayPeriods()

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

async function loadPayPeriods() {
  const { data, error } = await supabaseClient
    .from('pay_periods')
    .select('*')
    .order('start_date', { ascending: true });
  if (error) { console.error('Failed to load pay periods:', error); allPayPeriods = []; return; }
  allPayPeriods = data || [];
}

// The soonest period whose payday (end_date) hasn't passed yet — used for
// the "next payday" display on payroll-tools.html.
function getNextPayPeriod() {
  const today = ppStripTime(new Date());
  const upcoming = allPayPeriods
    .filter(p => ppStripTime(ppParseDate(p.end_date)) >= today)
    .sort((a, b) => ppParseDate(a.end_date) - ppParseDate(b.end_date));
  return upcoming[0] || null;
}

// The period whose start/end window contains today — used wherever an
// employee/manager/accounting view needs "the timesheet period we're
// currently in" rather than just the next payday. Falls back to
// getNextPayPeriod() if today doesn't fall inside any period (e.g. no
// period has been created yet for the current stretch, or the last one
// already ended and a new one hasn't been made).
function getCurrentPayPeriod() {
  const today = ppStripTime(new Date());
  const current = allPayPeriods.find(p =>
    ppStripTime(ppParseDate(p.start_date)) <= today && today <= ppStripTime(ppParseDate(p.end_date))
  );
  return current || getNextPayPeriod();
}

/* ----------------------------- Popup plumbing -----------------------------
   Generic show/hide for the .popup-overlay/.popup pattern used across
   payroll-tools.html, manage-employees.html, and time sheet.html. Lives here
   (rather than in one page's own script) since it's needed by all three. */

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
