const adminForm = document.getElementById('adminUserForm');
const adminMessage = document.getElementById('adminMessage');
const adminAccessNote = document.getElementById('adminAccessNote');

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
  const profile = getStoredProfile() || window.currentSupabaseProfile || null;
  const isAllowed = window.isSupabaseUserInGroup ? window.isSupabaseUserInGroup(profile, 'IT') : false;

  if (!adminForm) return;

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

if (adminForm) {
  enforceAccess();

  adminForm.addEventListener('submit', async function (event) {
    event.preventDefault();

    if (!enforceAccess()) {
      return;
    }

    const name = document.getElementById('adminFullName').value.trim();
    const username = document.getElementById('adminUsername').value.trim();
    const password = document.getElementById('adminPassword').value.trim();
    const group = document.getElementById('adminGroup').value.trim();

    if (!name || !username || !password) {
      setMessage(adminMessage, 'Please fill in all required fields.', 'error');
      return;
    }

    const createdUser = await window.createSupabaseUser({ name, username, password, group }, adminMessage);
    if (createdUser) {
      adminForm.reset();
      setMessage(adminMessage, `Created ${createdUser.full_name} in the ${createdUser.workgroup[0]} group.`, 'success');
    }
  });
}
