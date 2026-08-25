const adminForm = document.getElementById('adminUserForm');
const adminMessage = document.getElementById('adminMessage');
const adminAccessNote = document.getElementById('adminAccessNote');
const tempPasswordReveal = document.getElementById('tempPasswordReveal');
const tempPasswordForName = document.getElementById('tempPasswordForName');
const tempPasswordValue = document.getElementById('tempPasswordValue');
const copyTempPasswordBtn = document.getElementById('copyTempPasswordBtn');

function hideTempPasswordReveal() {
  if (tempPasswordReveal) tempPasswordReveal.style.display = 'none';
}

function showTempPasswordReveal(createdUser) {
  if (!tempPasswordReveal || !createdUser || !createdUser.temp_password) return;
  if (tempPasswordForName) tempPasswordForName.textContent = createdUser.full_name || createdUser.username || 'this user';
  if (tempPasswordValue) tempPasswordValue.textContent = createdUser.temp_password;
  if (copyTempPasswordBtn) copyTempPasswordBtn.textContent = 'Copy';
  tempPasswordReveal.style.display = 'block';
}

if (copyTempPasswordBtn) {
  copyTempPasswordBtn.addEventListener('click', async function () {
    const value = tempPasswordValue ? tempPasswordValue.textContent : '';
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      copyTempPasswordBtn.textContent = 'Copied';
      setTimeout(() => { copyTempPasswordBtn.textContent = 'Copy'; }, 2000);
    } catch (error) {
      console.warn('Unable to copy temp password automatically:', error);
      copyTempPasswordBtn.textContent = 'Select & copy manually';
    }
  });
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

function setMessage(element, text, type) {
  if (!element) {
    return;
  }

  element.textContent = text;
  element.className = `auth-message ${type}`;
}

function enforceAccess() {
  const isAllowed =
    window.isSupabaseUserInGroup
      ? (
          window.isSupabaseUserInGroup(getStoredProfile(), "IT") ||
          window.isSupabaseUserInGroup(getStoredProfile(), "Super Admin")
        )
      : false;

  if (!adminForm) return false;

  if (!isAllowed) {
    adminForm.style.display = 'none';
    setMessage(adminMessage, 'You do not have permission to create accounts. Only IT users can access this page.', 'error');
    if (adminAccessNote) {
      adminAccessNote.textContent = 'Access denied. Sign in with an IT account to continue.';
      adminAccessNote.className = 'auth-message error';
    }
    return false;
  }

  adminForm.style.display = 'block';
  if (adminAccessNote) {
    adminAccessNote.textContent = 'Access confirmed. Your account is authorized to create users in Supabase.';
    adminAccessNote.className = 'auth-message success';
  }
  return true;
}

// The dropdown ships with a hardcoded fallback list (Owner/Field/IT/Office/
// Accounting) so account creation still works before supabase-workgroups-
// setup.sql has been run. Once that migration exists, this swaps the
// options for whatever's actually in the Workgroups tab, so adding a new
// workgroup there makes it selectable here automatically.
async function populateGroupOptionsFromWorkgroups() {
  const select = document.getElementById('adminGroup');
  const hint = document.getElementById('adminGroupHint');
  if (!select || !window.supabaseClient) return;

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

  const currentValue = select.value;
  select.innerHTML = data
    .map((wg) => `<option value="${escapeHtml(wg.name)}">${escapeHtml(wg.name)}</option>`)
    .join('');
  if (data.some((wg) => wg.name === currentValue)) select.value = currentValue;

  if (hint) hint.style.display = 'block';
}

if (adminForm) {
  enforceAccess();
  populateGroupOptionsFromWorkgroups();

  adminForm.addEventListener('submit', async function (event) {
    event.preventDefault();

    if (!enforceAccess()) {
      return;
    }

    const name = document.getElementById('adminFullName').value.trim();
    const username = document.getElementById('adminUsername').value.trim();
    const group = document.getElementById('adminGroup').value.trim();

    if (!name || !username) {
      setMessage(adminMessage, 'Please fill in all required fields.', 'error');
      return;
    }

    hideTempPasswordReveal();

    const createdUser = await window.createSupabaseUser({ name, username, group }, adminMessage);
    if (createdUser) {
      adminForm.reset();
      setMessage(adminMessage, `Created ${createdUser.full_name} in the ${createdUser.workgroup[0]} group.`, 'success');
      showTempPasswordReveal(createdUser);
    }
  });
}