const loginStep = document.getElementById('loginStep');
const resetStep = document.getElementById('resetStep');
const form = document.getElementById('loginForm');
const message = document.getElementById('loginMessage');
const resetForm = document.getElementById('resetForm');
const resetMessage = document.getElementById('resetMessage');
const loadingOverlay = document.getElementById('loginLoadingOverlay');
const loadingSpinner = document.getElementById('loginLoadingSpinner');
const loadingText = document.getElementById('loginLoadingText');
const errorIcon = document.getElementById('loginErrorIcon');
const errorOkayBtn = document.getElementById('loginErrorOkayBtn');

function setMessage(element, text, type) {
  if (!element) {
    return;
  }

  element.textContent = text;
  element.className = `auth-message ${type}`;
}

// Shown instead of updating loginMessage/resetMessage's text while a
// sign-in or password-reset request is in flight (Coleby asked for a
// popup instead of the text swapping through "Signing in..."/"Access
// granted..."/etc, 2026-08-28). Stays generic ("Please wait...") rather
// than tracking each stage, so nothing here needs to change as a request
// progresses -- it just comes down once the request settles one way or
// another.
function showLoadingPopup() {
  if (!loadingOverlay) return;
  if (loadingSpinner) loadingSpinner.classList.remove('hidden');
  if (errorIcon) errorIcon.classList.add('hidden');
  if (errorOkayBtn) errorOkayBtn.classList.add('hidden');
  if (loadingText) {
    loadingText.textContent = 'Please wait...';
    loadingText.classList.remove('login-loading-text--error');
  }
  loadingOverlay.classList.remove('hidden');
}

function hideLoadingPopup() {
  if (loadingOverlay) loadingOverlay.classList.add('hidden');
}

// Swaps the same popup into an error state instead of leaving the error as
// plain text under the form -- spinner replaced by a warning icon, the
// message in red, and an Okay button to dismiss (Coleby asked for this
// 2026-08-28: "add the Incorrect username or password. to the popup with a
// okay"). Used for every sign-in/reset failure, not just that one message.
function showErrorPopup(text) {
  if (!loadingOverlay) return;
  if (loadingSpinner) loadingSpinner.classList.add('hidden');
  if (errorIcon) errorIcon.classList.remove('hidden');
  if (errorOkayBtn) errorOkayBtn.classList.remove('hidden');
  if (loadingText) {
    loadingText.textContent = text;
    loadingText.classList.add('login-loading-text--error');
  }
  loadingOverlay.classList.remove('hidden');
}

if (errorOkayBtn) {
  errorOkayBtn.addEventListener('click', hideLoadingPopup);
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
      showErrorPopup('Please enter your username and password.');
      return;
    }

    setMessage(message, '', '');
    showLoadingPopup();

    const matchedUser = await window.signInWithSupabase(username, password, message);
    if (!matchedUser) {
      // signInWithSupabase already wrote the real error (wrong
      // username/password, deactivated account, etc.) into `message` --
      // pull it into the popup instead of leaving it as text under the
      // form, then clear the inline copy so it isn't sitting there too
      // once the popup is dismissed.
      const errorText = message ? message.textContent : '';
      setMessage(message, '', '');
      showErrorPopup(errorText || 'Unable to sign in. Try again.');
      return;
    }

    if (await goToResetIfNeeded(matchedUser)) {
      hideLoadingPopup();
      return;
    }

    setTimeout(() => {
      window.location.href = '/pages/dashboard.html';
    }, 700);
  });
}

if (resetForm) {
  resetForm.addEventListener('submit', async function (event) {
    event.preventDefault();

    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (newPassword.length < 8) {
      showErrorPopup('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      showErrorPopup('Passwords do not match.');
      return;
    }
    if (!window.supabaseClient) {
      showErrorPopup('Unable to reach the server. Try again.');
      return;
    }

    showLoadingPopup();

    const { error } = await window.supabaseClient.auth.updateUser({ password: newPassword });
    if (error) {
      showErrorPopup(error.message || 'Unable to set your new password. Try again.');
      return;
    }

    if (typeof window.clearMustResetPassword === 'function') {
      await window.clearMustResetPassword();
    }

    setTimeout(() => {
      window.location.href = '/pages/dashboard.html';
    }, 700);
  });
}

// Arrived here via auth-guard.js's redirect for an existing session that's
// still flagged must_reset_password (e.g. IT reset someone's password, or
// they closed the tab before finishing their first-login reset last time).
if (new URLSearchParams(window.location.search).get('mustReset') === '1') {
  showResetStep();
}
