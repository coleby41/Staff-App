const userSearch = document.getElementById('userSearch');
const userList = document.getElementById('userList');
const directoryEmptyState = document.getElementById('directoryEmptyState');
const userDetailsForm = document.getElementById('userDetailsForm');
const selectedUserIdInput = document.getElementById('selectedUserId');
const fullNameInput = document.getElementById('fullName');
const usernameInput = document.getElementById('username');
const groupInput = document.getElementById('group');
const passwordInput = document.getElementById('password');
const staffRoleInput = document.getElementById('staffRole');
const staffManagerInput = document.getElementById('staffManager');
const employeeCodeInput = document.getElementById('employeeCode');
const accountNotesInput = document.getElementById('accountNotes');
const toggleActiveBtn = document.getElementById('toggleActiveBtn');
const directoryMessage = document.getElementById('directoryMessage');

let supabaseClient = null;
let allUsers = [];
let filteredUsers = [];
let selectedUserId = null;

function getSupabaseClient() {
  // Reuse the single shared client supabase-auth.js creates and keeps a
  // real, authenticated Supabase Auth session on — this file used to create
  // its OWN separate client instance here, which under real Supabase Auth
  // risks two GoTrueClient instances competing over the same session
  // storage (Supabase explicitly warns against this). window.supabaseClient
  // is set synchronously by supabase-auth.js before this file's script tag
  // runs (same load order as every other page), so it should already exist.
  supabaseClient = window.supabaseClient || supabaseClient;
  return supabaseClient;
}

function setMessage(element, text, type) {
  if (!element) return;
  element.textContent = text;
  element.className = `auth-message ${type}`;
}

function getStoredProfile() {
  try {
    const storedProfile = localStorage.getItem('staffProfile');
    return storedProfile ? JSON.parse(storedProfile) : null;
  } catch (error) {
    console.warn('Unable to load stored profile:', error);
    return null;
  }
}

// Resets someone else's real Supabase Auth password via the
// reset-staff-password Edge Function (service-role key server-side,
// IT/Super-Admin check on the caller). Writing password_hash directly (the
// old approach) no longer does anything real — login goes through Supabase
// Auth now, not that column — so this replaces that write entirely.
async function resetPasswordViaFunction(staffUserId, newPassword) {
  const config = window.SUPABASE_CONFIG || {};
  const client = getSupabaseClient();
  if (!client) return { error: 'Unable to reach the server. Try again.' };

  const { data: sessionData } = await client.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) return { error: 'Your session has expired. Please sign in again.' };

  let response;
  try {
    response = await fetch(`${config.url}/functions/v1/reset-staff-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ staff_user_id: staffUserId, new_password: newPassword }),
    });
  } catch (networkError) {
    console.error('resetPasswordViaFunction: network error', networkError);
    return { error: 'Unable to reach the server. Try again.' };
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) {
    return { error: result.error || 'Unable to reset that password.' };
  }
  return { ok: true };
}

async function hashPassword(password) {
  const passwordBuffer = new TextEncoder().encode(password);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', passwordBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function renderUserList(users) {
  if (!userList) return;
  if (!users.length) {
    userList.innerHTML = '<div class="directory-empty">No users match that search.</div>';
    return;
  }

  userList.innerHTML = users.map((user) => {
    const groups = Array.isArray(user.workgroup) ? user.workgroup.join(', ') : user.workgroup || '—';
    const isActive = user.active !== false;
    return `
      <button class="directory-user ${user.id === selectedUserId ? 'is-active' : ''}" type="button" data-user-id="${user.id}">
        <div class="directory-user__name">${user.full_name || '—'}</div>
        <div class="directory-user__meta">${user.username || '—'}</div>
        <div class="directory-user__meta">${groups}${user.role === 'Manager' ? ' · Manager' : ''}</div>
        <span class="directory-user__badge ${isActive ? '' : 'is-inactive'}">${isActive ? 'Active' : 'Inactive'}</span>
      </button>
    `;
  }).join('');
}

// 2026-08-20: Group used to be a free-text input — the only place in the app
// someone's workgroup could be typed by hand instead of picked from the live
// Workgroups list, same fix already applied to admin-users.html's
// Create-a-staff-account form (populateGroupOptionsFromWorkgroups() there).
// The select ships with a hardcoded fallback list (Owner/Field/IT/Office/
// Accounting) so this page still works before supabase-workgroups-setup.sql
// has been run; once that migration exists this swaps in whatever's actually
// in the Workgroups tab, so a workgroup added there becomes selectable here
// automatically. Called once on page load — unlike admin-users.html's
// version, this doesn't need to preserve "the value someone was about to
// submit" (there's no in-progress selection yet at load time), it only needs
// to run before the first showDetailsForm() call so the real select has real
// options before anything tries to select one.
async function populateGroupOptionsFromWorkgroups() {
  if (!groupInput || !window.supabaseClient) return;

  const { data, error } = await window.supabaseClient
    .from('workgroups')
    .select('name')
    .order('name', { ascending: true });

  if (error || !data || !data.length) return; // fail open: keep the hardcoded fallback options

  const escapeHtml = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
  };

  groupInput.innerHTML = data
    .map((wg) => `<option value="${escapeHtml(wg.name)}">${escapeHtml(wg.name)}</option>`)
    .join('');
}

// Guards against a real staff account's saved workgroup not being one of the
// live Workgroups options (a workgroup that's since been renamed/removed
// there, or any other legacy value) — a plain `select.value = x` silently
// does nothing if x isn't one of the <option>s, which here would show
// whatever option happened to be first instead of this person's real group,
// and then saving the form (which reads groupInput.value) would silently
// overwrite their real workgroup with that wrong one. Adding the value as its
// own option first means it always displays correctly and a save that
// doesn't touch this field can't corrupt it — the IT admin still sees an
// explicit "(not in Workgroups list)" marker if it's stale, rather than the
// page just quietly showing the wrong group.
function ensureGroupOption(value) {
  if (!groupInput || !value) return;
  const alreadyThere = Array.from(groupInput.options).some((opt) => opt.value === value);
  if (!alreadyThere) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = `${value} (not in Workgroups list)`;
    groupInput.appendChild(opt);
  }
}

// Rebuilds the Manager <select> from every other staff user (a user can't be
// their own manager). Called whenever allUsers refreshes and before setting
// staffManagerInput.value, since a <select> can't select a value that isn't
// one of its <option>s yet.
function populateManagerOptions() {
  if (!staffManagerInput) return;
  const currentValue = staffManagerInput.value;
  const options = allUsers
    .filter((user) => String(user.id) !== String(selectedUserId))
    .map((user) => `<option value="${user.id}">${user.full_name || user.username || 'Unnamed'}</option>`)
    .join('');
  staffManagerInput.innerHTML = `<option value="">— None —</option>${options}`;
  staffManagerInput.value = currentValue;
}

function showDetailsForm(user) {
  if (!user) {
    if (directoryEmptyState) directoryEmptyState.style.display = 'flex';
    if (userDetailsForm) userDetailsForm.style.display = 'none';
    return;
  }

  if (directoryEmptyState) directoryEmptyState.style.display = 'none';
  if (userDetailsForm) userDetailsForm.style.display = 'flex';

  selectedUserId = user.id;
  if (selectedUserIdInput) selectedUserIdInput.value = user.id || '';
  if (fullNameInput) fullNameInput.value = user.full_name || '';
  if (usernameInput) usernameInput.value = user.username || '';
  if (groupInput) {
    const groupValue = Array.isArray(user.workgroup) ? user.workgroup[0] || '' : user.workgroup || '';
    ensureGroupOption(groupValue);
    groupInput.value = groupValue;
  }
  if (passwordInput) passwordInput.value = '';
  if (staffRoleInput) staffRoleInput.value = user.role || 'Employee';
  populateManagerOptions();
  if (staffManagerInput) staffManagerInput.value = user.manager_id || '';
  if (employeeCodeInput) employeeCodeInput.value = user.employee_code || '';
  if (accountNotesInput) {
    accountNotesInput.value = user.account_notes || '';
  }
  if (toggleActiveBtn) {
    toggleActiveBtn.textContent = user.active === false ? 'Reactivate' : 'Deactivate';
  }
}

function applySearch(term) {
  const query = term.toLowerCase().trim();
  filteredUsers = query
    ? allUsers.filter((user) => [user.full_name, user.username, user.workgroup].some((value) => String(value || '').toLowerCase().includes(query)))
    : allUsers;
  renderUserList(filteredUsers);
}

async function loadStaffUsers() {
  const profile = getStoredProfile();

  const isAllowed =
    window.isSupabaseUserInGroup
      ? (
          window.isSupabaseUserInGroup(profile, "IT") ||
          window.isSupabaseUserInGroup(profile, "Super Admin")
        )
      : false;

  if (!isAllowed) {
    setMessage(directoryMessage, 'Access denied. Only IT users can view all staff accounts.', 'error');
    if (userList) userList.innerHTML = '';
    if (directoryEmptyState) directoryEmptyState.style.display = 'flex';
    if (userDetailsForm) userDetailsForm.style.display = 'none';
    return;
  }

  const config = window.SUPABASE_CONFIG || {};
  if (!config.url || config.url === 'YOUR_SUPABASE_URL' || !config.anonKey || config.anonKey === 'YOUR_SUPABASE_ANON_KEY') {
    setMessage(directoryMessage, 'Supabase is not configured yet.', 'error');
    return;
  }

  const client = getSupabaseClient();
  // Reads go through staff_users_directory (a view that omits password_hash)
  // now that the base table's RLS no longer grants anon a direct SELECT —
  // see supabase-staff-users-rls-setup.sql. Writes below still target
  // staff_users directly, which is unaffected by this.
  const { data, error } = await client.from('staff_users_directory').select('*').order('created_at', { ascending: false });

  if (error) {
    setMessage(directoryMessage, error.message || 'Unable to load staff users.', 'error');
    return;
  }

  allUsers = data || [];
  filteredUsers = allUsers;
  renderUserList(filteredUsers);

  if (allUsers.length) {
    const initialUser = allUsers[0];
    showDetailsForm(initialUser);
    setMessage(directoryMessage, `Showing ${allUsers.length} staff user${allUsers.length === 1 ? '' : 's'}.`, 'success');
  } else {
    showDetailsForm(null);
    setMessage(directoryMessage, 'No staff users found in Supabase.', 'success');
  }
}

async function updateSelectedUser(updates) {
  if (!selectedUserId) return false;
  const client = getSupabaseClient();
  // Use { count: 'exact' } rather than .select() to detect zero-row updates.
  // .select() would ask PostgREST to read the row back after writing it,
  // which needs its own SELECT RLS grant — and staff_users deliberately has
  // none for anon (that's what keeps password_hash from being readable
  // directly; see supabase-staff-users-rls-setup.sql). count instead reflects
  // how many rows the UPDATE's own policy actually matched, with no read-back
  // required, so it can't be fooled by the missing SELECT policy.
  const { error, count } = await client
    .from('staff_users')
    .update(updates, { count: 'exact' })
    .eq('id', selectedUserId);
  if (error) {
    setMessage(directoryMessage, error.message || 'Unable to update user.', 'error');
    return false;
  }

  if (!count) {
    setMessage(directoryMessage, 'No changes were saved — the update matched 0 rows (likely a Supabase RLS permission issue on staff_users, or the selected user no longer exists).', 'error');
    return false;
  }

  setMessage(directoryMessage, 'User updated successfully.', 'success');
  await loadStaffUsers();
  return true;
}

userList.addEventListener('click', async function (event) {
  const button = event.target.closest('button[data-user-id]');
  if (!button) return;
  const userId = button.getAttribute('data-user-id');
  const selectedUser = allUsers.find((user) => String(user.id) === String(userId));
  if (!selectedUser) return;
  showDetailsForm(selectedUser);
  renderUserList(filteredUsers);
});

userSearch.addEventListener('input', function (event) {
  applySearch(event.target.value);
});

userDetailsForm.addEventListener('submit', async function (event) {
  event.preventDefault();

  const updates = {
    full_name: fullNameInput.value.trim(),
    username: usernameInput.value.trim(),
    workgroup: [groupInput.value.trim() || 'Operations'],
    role: staffRoleInput ? staffRoleInput.value : 'Employee',
    manager_id: staffManagerInput && staffManagerInput.value ? staffManagerInput.value : null,
    employee_code: employeeCodeInput && employeeCodeInput.value.trim() ? employeeCodeInput.value.trim() : null,
    account_notes: accountNotesInput ? accountNotesInput.value.trim() : ''
  };

  const newPassword = passwordInput.value.trim();
  const pendingPasswordReset = newPassword ? selectedUserId : null;

  const savedFields = await updateSelectedUser(updates);

  if (pendingPasswordReset) {
    const result = await resetPasswordViaFunction(pendingPasswordReset, newPassword);
    if (result.error) {
      setMessage(directoryMessage, result.error, 'error');
    } else if (savedFields) {
      setMessage(directoryMessage, 'User updated and password reset successfully.', 'success');
    }
  }

  const refreshedUser = allUsers.find((user) => String(user.id) === String(selectedUserId));
  if (refreshedUser) {
    showDetailsForm(refreshedUser);
  }
});

toggleActiveBtn.addEventListener('click', async function () {
  if (!selectedUserId) return;
  const currentUser = allUsers.find((user) => String(user.id) === String(selectedUserId));
  if (!currentUser) return;
  const nextActiveState = currentUser.active === false;
  await updateSelectedUser({ active: nextActiveState });
});

window.addEventListener('DOMContentLoaded', async function () {
  // Populate the live Workgroups list into the Group <select> before the
  // first showDetailsForm() call (inside loadStaffUsers) tries to select a
  // value into it — ensureGroupOption() still covers any per-user legacy
  // value even if this fails or hasn't loaded yet (fail-open, same as
  // admin-users.js's version).
  await populateGroupOptionsFromWorkgroups();
  await loadStaffUsers();
});