const loginStep = document.getElementById('loginStep');
const resetStep = document.getElementById('resetStep');
const form = document.getElementById('loginForm');
const message = document.getElementById('loginMessage');
const resetForm = document.getElementById('resetForm');
const resetMessage = document.getElementById('resetMessage');

function setMessage(element, text, type) {
  if (!element) {
    return;
  }

  element.textContent = text;
  element.className = `auth-message ${type}`;
}

function showResetStep() {
  if (loginStep) loginStep.style.display = 'none';
  if (resetStep) resetStep.style.display = 'block';
}

function showLoginStep() {
  if (resetStep) resetStep.style.display = 'none';
  if (loginStep) loginStep.style.display = 'block';
}

async function goToResetIfNeeded(profile) {
  if (profile && profile.must_reset_password) {
    showResetStep();
    return true;
  }
  return false;
}

if (form) {
  form.addEventListener('submit', async function (event) {
    event.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();

    if (!username || !password) {
      setMessage(message, 'Please enter your username and password.', 'error');
      return;
    }

    setMessage(message, 'Signing in...', 'success');

    const matchedUser = await window.signInWithSupabase(username, password, message);
    if (!matchedUser) return;

    if (await goToResetIfNeeded(matchedUser)) return;

    setMessage(message, 'Access granted. Redirecting to the dashboard...', 'success');
    setTimeout(() => {
      window.location.href = 'dashboard.html';
    }, 700);
  });
}

if (resetForm) {
  resetForm.addEventListener('submit', async function (event) {
    event.preventDefault();

    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (newPassword.length < 8) {
      setMessage(resetMessage, 'Password must be at least 8 characters.', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage(resetMessage, 'Passwords do not match.', 'error');
      return;
    }
    if (!window.supabaseClient) {
      setMessage(resetMessage, 'Unable to reach the server. Try again.', 'error');
      return;
    }

    setMessage(resetMessage, 'Saving your new password...', 'success');

    const { error } = await window.supabaseClient.auth.updateUser({ password: newPassword });
    if (error) {
      setMessage(resetMessage, error.message || 'Unable to set your new password. Try again.', 'error');
      return;
    }

    if (typeof window.clearMustResetPassword === 'function') {
      await window.clearMustResetPassword();
    }

    setMessage(resetMessage, 'Password updated. Redirecting to the dashboard...', 'success');
    setTimeout(() => {
      window.location.href = 'dashboard.html';
    }, 700);
  });
}

// Arrived here via auth-guard.js's redirect for an existing session that's
// still flagged must_reset_password (e.g. IT reset someone's password, or
// they closed the tab before finishing their first-login reset last time).
if (new URLSearchParams(window.location.search).get('mustReset') === '1') {
  showResetStep();
}
