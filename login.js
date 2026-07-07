const form = document.getElementById('loginForm');
const message = document.getElementById('loginMessage');

function setMessage(element, text, type) {
  if (!element) {
    return;
  }

  element.textContent = text;
  element.className = `auth-message ${type}`;
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
    if (matchedUser) {
      setMessage(message, 'Access granted. Redirecting to the dashboard...', 'success');
      setTimeout(() => {
        window.location.href = 'dashboard.html';
      }, 700);
    }
  });
}
