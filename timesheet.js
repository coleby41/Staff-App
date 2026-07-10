// ============================================================
// COMBINED DASHBOARD SCRIPT
// Merged from two source files:
//   - Timesheet / payroll schedule / announcements logic
//   - Header profile / nav access / sign-out / notifications logic
// Plus: My Documents (Supabase-backed upload/list/delete)
// ============================================================

// ---- UI only — no backend calls beyond what's already wired below. ----

let view = 'mine'; // 'mine' | 'team'
let draftRows = []; // rows staged locally before the weekly submit

/* ===========================
   BIWEEKLY PAYROLL SUBMISSION SCHEDULE
=========================== */
// TODO: move PAYROLL_ANCHOR_KEY and the "submitted period" flag to a shared Supabase settings/entries
// table. Right now they're in localStorage, so they're per-browser, not shared across staff or devices.
// NOTE: the anchor date itself is set from payroll-tools.html (Accounting only). This page only
// reads it to know when the submission window is open.
const PAYROLL_ANCHOR_KEY = 'payrollAnchorDate';   // accounting-set date, e.g. "2026-07-09"
const SUBMITTED_PERIOD_KEY = 'timesheetSubmittedPeriod';
const DRAFT_STORAGE_KEY = 'timesheetDraftRows';
const msPerDay = 86400000;

/* ===========================
   ANNOUNCEMENTS FROM ACCOUNTING (Supabase)
   Uses window.supabaseClient, exposed globally by supabase-auth.js.
   Reads the same `announcements` table that payroll-tools.html writes to.
=========================== */

async function getAnnouncements() {
  if (!window.supabaseClient) { console.error('Supabase client not ready yet'); return []; }
  const { data, error } = await window.supabaseClient
    .from('announcements')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { console.error('Failed to load announcements:', error); return []; }
  return data;
}

// Renders the announcements card. Call on load and whenever announcements might have changed.
async function renderAnnouncements() {
  const items = await getAnnouncements();
  const wrap = document.getElementById('announcementsWrap');
  const container = document.getElementById('announcementsList');
  if (!items || items.length === 0) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'block';
  container.innerHTML = '';
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'announcement-item';
    div.innerHTML = `
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.message)}</p>
      <div class="announcement-date">${new Date(item.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</div>
    `;
    container.appendChild(div);
  });
}

/* ===========================
   PAYROLL DATE HELPERS
=========================== */

function stripTime(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function getPayrollAnchor() {
  const stored = localStorage.getItem(PAYROLL_ANCHOR_KEY);
  return stored ? stripTime(new Date(stored + 'T00:00:00')) : null;
}

function isPayrollThursday(date, anchor) {
  if (!anchor) return false;
  const diffDays = Math.round((stripTime(date) - anchor) / msPerDay);
  return diffDays >= 0 && diffDays % 14 === 0;
}

// Most recent payroll Thursday on or before `date` — used as the id for "which period is this"
function getCurrentPeriodId(anchor, date) {
  const diffDays = Math.floor((stripTime(date) - anchor) / msPerDay);
  const cycles = Math.floor(diffDays / 14);
  const periodStart = new Date(anchor.getTime() + cycles * 14 * msPerDay);
  return periodStart.toISOString().slice(0, 10);
}

function getNextPayrollThursday(anchor, date) {
  const diffDays = Math.round((stripTime(date) - anchor) / msPerDay);
  if (diffDays <= 0) return anchor;
  const cyclesPassed = Math.ceil(diffDays / 14);
  return new Date(anchor.getTime() + cyclesPassed * 14 * msPerDay);
}

function formatDate(d) {
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function saveDraftToStorage() { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draftRows)); }
function loadDraftFromStorage() {
  const stored = localStorage.getItem(DRAFT_STORAGE_KEY);
  draftRows = stored ? JSON.parse(stored) : [];
}

// Shows/hides the Submit button vs. the "next submission opens..." message
function updateSubmitAvailability() {
  const anchor = getPayrollAnchor();
  const submitBtn = document.getElementById('submitWeekBtn');
  const windowMsg = document.getElementById('submissionWindowMsg');
  const today = new Date();

  if (!anchor) {
    submitBtn.style.display = 'none';
    windowMsg.textContent = 'Submission schedule not set yet — contact accounting.';
    windowMsg.style.display = 'block';
    return;
  }

  if (isPayrollThursday(today, anchor)) {
    windowMsg.style.display = 'none';
    submitBtn.style.display = 'block';
    submitBtn.disabled = draftRows.length === 0;
  } else {
    submitBtn.style.display = 'none';
    windowMsg.textContent = `Next submission opens ${formatDate(getNextPayrollThursday(anchor, today))}.`;
    windowMsg.style.display = 'block';
  }
}

// Checks whether the current period was already submitted (locked) or a new period has started
// (auto-unlock). Run this on page load.
function checkSubmissionLock() {
  const anchor = getPayrollAnchor();
  if (!anchor) { updateSubmitAvailability(); return; }
  const today = new Date();
  if (stripTime(today) < anchor) { updateSubmitAvailability(); return; } // before the first period

  const currentPeriodId = getCurrentPeriodId(anchor, today);
  const submittedPeriodId = localStorage.getItem(SUBMITTED_PERIOD_KEY);

  if (submittedPeriodId === currentPeriodId) {
    showSubmittedState();
  } else {
    resetWeeklySubmission(); // new period since last submission — unlock automatically
  }
}

function showSubmittedState() {
  document.getElementById('entryForm').style.display = 'none';
  document.getElementById('draftWrap').style.display = 'none';
  document.getElementById('submitWeekBtn').style.display = 'none';
  document.getElementById('submissionWindowMsg').style.display = 'none';
  document.getElementById('submittedBanner').style.display = 'block';
}

/* ===========================
   VIEW / TIMESHEET UI
=========================== */

function setView(v) {
  view = v;
  document.getElementById('btnMine').classList.toggle('active', v === 'mine');
  document.getElementById('btnTeam').classList.toggle('active', v === 'team');
  document.getElementById('colUser').style.display = v === 'team' ? '' : 'none';
  document.getElementById('addEntryBlock').style.display = v === 'mine' ? 'block' : 'none';
  // TODO: reload timesheet/document data for the selected view
}

// Show the Team View toggle only for admins — set this from your auth/user data
function setIsAdmin(isAdmin) {
  document.getElementById('viewToggle').style.display = isAdmin ? 'inline-flex' : 'none';
}

// Stage a row locally — nothing is submitted yet
function addRow() {
  const work_date = document.getElementById('fDate').value;
  const project = document.getElementById('fProject').value.trim();
  const hours = parseFloat(document.getElementById('fHours').value);
  const category = document.getElementById('fCategory').value;
  const notes = document.getElementById('fNotes').value.trim();
  const msg = document.getElementById('entryMsg');
  if (!work_date || !project || !hours) { msg.textContent = 'Date, project, and hours are required.'; msg.className = 'msg error'; return; }

  draftRows.push({ work_date, project, hours, category, notes });

  document.getElementById('fDate').value = '';
  document.getElementById('fProject').value = '';
  document.getElementById('fHours').value = '';
  document.getElementById('fNotes').value = '';
  msg.textContent = '';
  saveDraftToStorage();
  renderDraft();
}

function removeRow(index) {
  draftRows.splice(index, 1);
  saveDraftToStorage();
  renderDraft();
}

function renderDraft() {
  const wrap = document.getElementById('draftWrap');
  const body = document.getElementById('draftBody');
  const total = document.getElementById('draftTotal');

  wrap.style.display = draftRows.length ? 'block' : 'none';
  body.innerHTML = '';
  let sum = 0;
  draftRows.forEach((row, i) => {
    sum += row.hours;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.work_date}</td>
      <td>${escapeHtml(row.project)}</td>
      <td>${row.hours}</td>
      <td>${row.category}</td>
      <td><button class="btn small danger" onclick="removeRow(${i})">Remove</button></td>
    `;
    body.appendChild(tr);
  });
  total.textContent = sum.toFixed(1);
  updateSubmitAvailability();
}

// Submits all staged rows as one batch, only allowed on an actual payroll Thursday
function submitWeekForApproval() {
  const msg = document.getElementById('submitMsg');
  const anchor = getPayrollAnchor();
  const today = new Date();

  if (draftRows.length === 0) { msg.textContent = 'Add at least one row first.'; msg.className = 'msg error'; return; }
  if (!anchor || !isPayrollThursday(today, anchor)) { msg.textContent = 'Submissions only open on the scheduled payroll Thursday.'; msg.className = 'msg error'; return; }

  // TODO: send draftRows to your data source in one batch, each with status: 'pending'
  // e.g. await window.supabaseClient.from('timesheet_entries').insert(draftRows.map(r => ({ ...r, status: 'pending' })));

  localStorage.setItem(SUBMITTED_PERIOD_KEY, getCurrentPeriodId(anchor, today));
  localStorage.removeItem(DRAFT_STORAGE_KEY);
  draftRows = [];
  msg.textContent = '';
  showSubmittedState();
  // TODO: refresh renderTimesheet() from your data source so the new pending rows show up in the table above
}

// Unlocks the form for a fresh period. Called automatically once the current payroll period
// no longer matches the one that was last submitted — no admin action required.
function resetWeeklySubmission() {
  document.getElementById('entryForm').style.display = 'block';
  document.getElementById('submittedBanner').style.display = 'none';
  loadDraftFromStorage();
  renderDraft();
}

function setStatus(id, status) {
  // TODO: update entry `id` to `status` ('approved' | 'rejected') in your data source
}

// Example row renderer for reference — call with your fetched data:
// renderTimesheet([{ id, work_date, project, hours, status, staff_name }])
function renderTimesheet(rows) {
  const body = document.getElementById('timesheetBody');
  const empty = document.getElementById('timesheetEmpty');
  body.innerHTML = '';
  if (!rows || rows.length === 0) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  rows.forEach(row => {
    const tr = document.createElement('tr');
    const canModerate = view === 'team' && row.status === 'pending';
    tr.innerHTML = `
      <td>${row.work_date}</td>
      <td>${escapeHtml(row.project)}</td>
      <td>${row.hours}</td>
      <td><span class="status-pill ${row.status}">${row.status}</span></td>
      <td style="display:${view === 'team' ? '' : 'none'};">${escapeHtml(row.staff_name || '—')}</td>
      <td>${canModerate ? `<button class="btn small" onclick="setStatus('${row.id}','approved')">Approve</button> <button class="btn small danger" onclick="setStatus('${row.id}','rejected')">Reject</button>` : ''}</td>
    `;
    body.appendChild(tr);
  });
}

/* ===========================
   MY DOCUMENTS (Supabase)
   Table: staff_documents (RLS: user_id = auth.uid())
   Bucket: staff-documents (private; path = {user_id}/{uuid}-{filename})
=========================== */

const ALLOWED_DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic'];
const MAX_DOC_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const CATEGORY_LABELS = { w2: 'W-2 Tax Form', w4: 'W-4 Tax Form', '1099': '1099 Tax Form', other: 'Other Form' };

async function loadDocuments() {
  if (!window.supabaseClient) { console.error('Supabase client not ready yet'); return; }

  const profile = getAvailableProfile();
  const userId = profile?.id || profile?.uid;
  if (!userId) { console.warn('No user id yet — skipping document load'); return; }

  const { data, error } = await window.supabaseClient
    .from('staff_documents')
    .select('*')
    .eq('user_id', userId)
    .order('uploaded_at', { ascending: false });

  if (error) { console.error('Failed to load documents:', error); return; }

  await renderDocuments(data || []);
}

async function uploadDoc() {
  const fileInput = document.getElementById('docFile');
  const category = document.getElementById('docCategory').value;
  const msg = document.getElementById('docMsg');
  const file = fileInput.files[0];

  if (!file) { msg.textContent = 'Choose a file first.'; msg.className = 'msg error'; return; }
  if (!ALLOWED_DOC_TYPES.includes(file.type)) {
    msg.textContent = 'Only PDF or image files (JPG, PNG, HEIC) are allowed.';
    msg.className = 'msg error';
    return;
  }
  if (file.size > MAX_DOC_SIZE_BYTES) {
    msg.textContent = 'File is too large (10MB max).';
    msg.className = 'msg error';
    return;
  }

  const profile = getAvailableProfile();
  const userId = profile?.id || profile?.uid;
  if (!userId) { msg.textContent = 'Still loading your profile — try again in a moment.'; msg.className = 'msg error'; return; }

  msg.textContent = 'Uploading...';
  msg.className = 'msg';

  const filePath = `${userId}/${crypto.randomUUID()}-${file.name}`;

  const { error: uploadError } = await window.supabaseClient
    .storage
    .from('staff-documents')
    .upload(filePath, file);

  if (uploadError) {
    console.error('Storage upload failed:', uploadError);
    msg.textContent = 'Upload failed. Please try again.';
    msg.className = 'msg error';
    return;
  }

  const { error: insertError } = await window.supabaseClient
    .from('staff_documents')
    .insert({
      user_id: userId,
      file_name: file.name,
      file_path: filePath,
      category
    });

  if (insertError) {
    console.error('Failed to save document record:', insertError);
    // Clean up the orphaned storage file since the DB row failed
    await window.supabaseClient.storage.from('staff-documents').remove([filePath]);
    msg.textContent = 'Upload failed. Please try again.';
    msg.className = 'msg error';
    return;
  }

  fileInput.value = '';
  msg.textContent = 'Uploaded successfully.';
  msg.className = 'msg success';
  loadDocuments();
}

async function deleteDoc(id, filePath) {
  if (!confirm('Delete this document? This cannot be undone.')) return;

  const { error: storageError } = await window.supabaseClient
    .storage
    .from('staff-documents')
    .remove([filePath]);

  if (storageError) { console.error('Failed to delete file from storage:', storageError); }

  const { error: dbError } = await window.supabaseClient
    .from('staff_documents')
    .delete()
    .eq('id', id);

  if (dbError) {
    console.error('Failed to delete document record:', dbError);
    return;
  }

  loadDocuments();
}

async function renderDocuments(docs) {
  const list = document.getElementById('docList');
  const empty = document.getElementById('docEmpty');
  list.innerHTML = '';

  if (!docs || docs.length === 0) {
    empty.style.display = 'block';
    updateMetrics({ docCount: 0 });
    return;
  }
  empty.style.display = 'none';

  for (const doc of docs) {
    const { data: signedUrlData, error } = await window.supabaseClient
      .storage
      .from('staff-documents')
      .createSignedUrl(doc.file_path, 60); // link valid for 60 seconds

    const url = error ? '#' : signedUrlData.signedUrl;

    const div = document.createElement('div');
    div.className = 'doc-item';
    div.innerHTML = `
      <div>
        <h3>${escapeHtml(doc.file_name)}</h3>
        <p>${escapeHtml(CATEGORY_LABELS[doc.category] || doc.category)} · ${new Date(doc.uploaded_at).toLocaleDateString()}</p>
      </div>
      <div style="display:flex; gap:6px;">
        <a class="btn small secondary" href="${url}" target="_blank" rel="noopener">Open</a>
        <button class="btn small danger" onclick="deleteDoc('${doc.id}', '${doc.file_path}')">Delete</button>
      </div>
    `;
    list.appendChild(div);
  }

  updateMetrics({ docCount: docs.length });
}

/* ===========================
   METRICS (merges instead of overwriting, since hours/docs/pending
   are updated independently by different loaders)
=========================== */

let metricsState = { weekHours: 0, pending: 0, docCount: 0 };

function updateMetrics(partial = {}) {
  metricsState = { ...metricsState, ...partial };
  document.getElementById('metricHours').textContent = metricsState.weekHours.toFixed(1);
  document.getElementById('metricPending').textContent = metricsState.pending;
  document.getElementById('metricDocs').textContent = metricsState.docCount;
}

// Shared HTML-escaping helper (used by draft/timesheet/document/announcement/notification renderers)
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

/* ===========================
   SIGN OUT
=========================== */

const signOutButton = document.getElementById('signOutButton');

if (signOutButton) {
  signOutButton.addEventListener('click', function (event) {
    event.stopPropagation();
    if (typeof window.signOutUser === 'function') {
      window.signOutUser();
    } else {
      console.error('signOutUser() is not available');
    }
  });
}

/* ===========================
   ELEMENTS - header/profile
=========================== */

const userNameElement = document.getElementById('headerUserName');
const welcomeHeading = document.getElementById('welcomeHeading');
const adminNavGroup = document.getElementById('adminNavGroup');
const brandInitials = document.getElementById('brandInitials');

/* ===========================
   UPDATE STAFF NAME
=========================== */

function updateStaffName(profile) {
  if (!profile) return;

  const name = profile.full_name || profile.username || 'Staff';

  // Update only the text so the bell does not disappear
  if (userNameElement) {
    userNameElement.textContent = name;
  }

  if (welcomeHeading) {
    welcomeHeading.textContent = `Welcome, ${name}`;
  }

  if (brandInitials) {
    const words = String(name).trim().split(/\s+/).filter(Boolean);
    const initials = words.length >= 2
      ? `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
      : words[0]?.substring(0, 2).toUpperCase() || 'ST';
    brandInitials.textContent = initials;
  }

  const sidebarGroupPill = document.getElementById('sidebarGroupPill');
  if (sidebarGroupPill) {
    const groups = window.getSupabaseUserGroups ? window.getSupabaseUserGroups(profile) : [];
    sidebarGroupPill.textContent = groups.length
      ? groups.map(g => g.charAt(0).toUpperCase() + g.slice(1)).join(', ')
      : 'No Group';
  }
}

/* ===========================
   NAV ACCESS
=========================== */

function updateNavAccess(profile) {
  const shouldShowAdminNav = window.isSupabaseUserInGroup
    ? (window.isSupabaseUserInGroup(profile, 'IT') || window.isSupabaseUserInGroup(profile, 'Super Admin'))
    : false;

  if (adminNavGroup) {
    adminNavGroup.style.display = shouldShowAdminNav ? 'block' : 'none';
  }

  const payrollToolsNavItem = document.getElementById('payrollToolsNavItem');

  // Payroll Tools is visible to the Office and Accounting workgroups (plus Super Admin).
  const shouldShowPayrollTools = window.isSupabaseUserInGroup
    ? (
        window.isSupabaseUserInGroup(profile, 'Office') ||
        window.isSupabaseUserInGroup(profile, 'Accounting') ||
        window.isSupabaseUserInGroup(profile, 'Super Admin')
      )
    : false;

  if (payrollToolsNavItem) {
    payrollToolsNavItem.style.display = shouldShowPayrollTools ? 'flex' : 'none';
  }
}

/* ===========================
   LOAD PROFILE (with retry/poll)
   window.currentSupabaseProfile is only populated by supabase-auth.js during
   an active sign-in — on a normal page load/reload it's undefined, so the
   fallback is whatever was cached in localStorage.staffProfile at sign-in
   time. That fallback is normally enough by itself, but if auth-guard.js (or
   anything else validating the session) writes/refreshes that value slightly
   after this script's DOMContentLoaded check runs, a single check can still
   miss it. To be safe regardless of that timing, we poll for a few seconds
   instead of checking exactly once.
=========================== */

let profileInitDone = false;

function getStoredProfile() {
  try {
    return JSON.parse(localStorage.getItem('staffProfile') || 'null');
  } catch (error) {
    console.warn('Unable to parse stored profile:', error);
    return null;
  }
}

function getAvailableProfile() {
  return window.currentSupabaseProfile || getStoredProfile();
}

function applyProfileIfAvailable() {
  const profile = getAvailableProfile();
  if (profile) {
    updateStaffName(profile);
    updateNavAccess(profile);
    profileInitDone = true;
  }
  return profile;
}

// Tries immediately, then retries every 200ms for up to ~5s (25 attempts).
function pollForProfile(maxAttempts = 25, intervalMs = 200) {
  if (applyProfileIfAvailable()) {
    loadDocuments(); // profile was already available — safe to load docs now
    return;
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    const profile = applyProfileIfAvailable();
    if (profile || attempts >= maxAttempts) {
      clearInterval(timer);
      if (profile) {
        loadDocuments(); // profile just became available — load docs now
      } else if (!profileInitDone) {
        console.warn('No staff profile found after waiting — name/nav may not reflect the signed-in user. Check that localStorage.staffProfile is being set (e.g. by auth-guard.js) on this page.');
      }
    }
  }, intervalMs);
}

/* ===========================
   NOTIFICATIONS (Supabase)
   Uses window.supabaseClient, exposed globally by supabase-auth.js.
   Reads broadcast notifications (user_id null, e.g. announcements) plus
   anything targeted at this specific user (e.g. timesheet approvals).
   "Read" state is tracked client-side in localStorage — fine for a
   single-browser-per-person setup; move it server-side later if you
   need read state to follow someone across devices.
=========================== */

let currentNotifications = [];
const READ_IDS_KEY = 'readNotificationIds';

function getReadNotificationIds() {
  try { return new Set(JSON.parse(localStorage.getItem(READ_IDS_KEY) || '[]')); }
  catch { return new Set(); }
}

function markNotificationsRead(ids) {
  const read = getReadNotificationIds();
  ids.forEach(id => read.add(id));
  localStorage.setItem(READ_IDS_KEY, JSON.stringify([...read]));
}

async function loadNotifications() {
  if (!window.supabaseClient) { console.error('Supabase client not ready yet'); return; }

  const profile = window.currentSupabaseProfile
    || JSON.parse(localStorage.getItem('staffProfile') || 'null');
  const userId = profile?.id || profile?.uid || null;

  let query = window.supabaseClient
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  query = userId
    ? query.or(`user_id.is.null,user_id.eq.${userId}`)
    : query.is('user_id', null);

  const { data, error } = await query;
  if (error) { console.error('Failed to load notifications:', error); return; }

  currentNotifications = data || [];
  renderNotifications();
}

function renderNotifications() {
  const list = document.getElementById('notificationList');
  const empty = document.getElementById('notificationEmpty');
  const countEl = document.querySelector('.notification-count');
  const readIds = getReadNotificationIds();
  const unreadCount = currentNotifications.filter(n => !readIds.has(n.id)).length;

  if (countEl) {
    if (unreadCount > 0) {
      countEl.style.display = 'inline-flex';
      countEl.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    } else {
      countEl.style.display = 'none';
    }
  }

  if (!list) return;
  list.innerHTML = '';

  if (currentNotifications.length === 0) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  currentNotifications.forEach(n => {
    const div = document.createElement('div');
    div.className = 'notification-item';
    div.innerHTML = `
      <strong>${escapeHtml(n.title)}</strong>
      <p>${escapeHtml(n.message)}</p>
    `;
    list.appendChild(div);
  });
}

// Mark everything currently loaded as read the moment the bell is opened.
// notificationBell/notificationDropdown are assumed to be declared in script.js,
// which should load before this file, so they're already available here.
if (typeof notificationBell !== 'undefined' && notificationBell) {
  notificationBell.addEventListener('click', function () {
    if (currentNotifications.length === 0) return;
    markNotificationsRead(currentNotifications.map(n => n.id));
    renderNotifications(); // just updates the badge; list itself stays the same
  });
}

/* ===========================
   PAGE INIT
=========================== */

window.addEventListener('DOMContentLoaded', function () {
  pollForProfile();        // retries for a few seconds until the profile shows up; loads docs once found
  checkSubmissionLock();   // shows submitted-state banner, or unlocks a fresh period + restores drafts
  renderAnnouncements();   // shows any messages Accounting has sent
  loadNotifications();     // loads bell notifications
});