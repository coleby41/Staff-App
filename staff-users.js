const userSearch = document.getElementById('userSearch');
const userList = document.getElementById('userList');
const directoryEmptyState = document.getElementById('directoryEmptyState');
const userDetailsForm = document.getElementById('userDetailsForm');
const selectedUserIdInput = document.getElementById('selectedUserId');
const fullNameInput = document.getElementById('fullName');
const usernameInput = document.getElementById('username');
const groupInput = document.getElementById('group');
const statusSelect = document.getElementById('status');
const passwordInput = document.getElementById('password');
const toggleActiveBtn = document.getElementById('toggleActiveBtn');
const directoryMessage = document.getElementById('directoryMessage');

let supabaseClient = null;
let allUsers = [];
let filteredUsers = [];
let selectedUserId = null;

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  const config = window.SUPABASE_CONFIG || {};
  const { createClient } = window.supabase;
  supabaseClient = createClient(config.url, config.anonKey);
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

async function hashPassword(password) {
  const passwordBuffer = new TextEncoder().encode(password);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', passwordBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
        <div class="directory-user__meta">${groups}</div>
        <span class="directory-user__badge ${isActive ? '' : 'is-inactive'}">${isActive ? 'Active' : 'Inactive'}</span>
      </button>
    `;
  }).join('');
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
  if (groupInput) groupInput.value = Array.isArray(user.workgroup) ? user.workgroup[0] || '' : user.workgroup || '';
  if (statusSelect) statusSelect.value = user.active === false ? 'inactive' : 'active';
  if (passwordInput) passwordInput.value = '';
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
  const profile = getStoredProfile() || window.currentSupabaseProfile || null;
  const isAllowed = window.isSupabaseUserInGroup ? window.isSupabaseUserInGroup(profile, 'IT') : false;

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
  const { data, error } = await client.from('staff_users').select('*').order('created_at', { ascending: false });

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
  const { error } = await client.from('staff_users').update(updates).eq('id', selectedUserId);
  if (error) {
    setMessage(directoryMessage, error.message || 'Unable to update user.', 'error');
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
    workgroup: [groupInput.value.trim() || 'Operations']
  };

  if (statusSelect.value === 'inactive') {
    updates.active = false;
  } else {
    updates.active = true;
  }

  if (passwordInput.value.trim()) {
    updates.password_hash = await hashPassword(passwordInput.value);
  }

  await updateSelectedUser(updates);
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

window.addEventListener('DOMContentLoaded', loadStaffUsers);
