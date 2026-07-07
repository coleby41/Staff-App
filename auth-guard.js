(function () {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  const isLoginPage = path === 'login.html' || path === 'index.html';
  const hasSession = Boolean(localStorage.getItem('staffProfile'));

  if (isLoginPage) {
    if (hasSession) {
      window.location.replace('dashboard.html');
    }
    return;
  }

  if (!hasSession) {
    window.location.replace('login.html');
  }
})();
