(function () {
  const path = window.location.pathname.split('/').pop() || '/index.html';
  const isLoginPage = path === '/pages/login.html' || path === '/index.html';

  // Real Supabase Auth session check (was: Boolean(localStorage.getItem
  // ('staffProfile'))). That old check was cosmetic — anyone could set that
  // key by hand in devtools. getSession() reflects a cryptographically
  // verified session Supabase itself issued; nothing in the browser can
  // forge one. (Every actual data request is protected by RLS regardless of
  // what this guard decides — this just controls the page-level redirect
  // experience, same role auth-guard.js always played.)
  async function checkSession() {
    if (!window.supabaseClient) {
      // supabase-auth.js couldn't set up a client (e.g. not configured
      // yet) — nothing meaningful to check here; leave the page alone
      // rather than looping redirects.
      return;
    }

    const { data } = await window.supabaseClient.auth.getSession();
    const session = data?.session || null;

    if (!session) {
      if (!isLoginPage) window.location.replace('/pages/login.html');
      return;
    }

    // Someone can have a valid session but still be flagged
    // must_reset_password (a fresh account, or IT reset their password) —
    // keep them on (or send them to) the login page's reset step rather
    // than letting them continue on their old/temporary password, and
    // rather than bouncing them straight to the dashboard just because a
    // session exists.
    const { data: profileRow } = await window.supabaseClient
      .from('staff_users')
      .select('must_reset_password')
      .eq('auth_user_id', session.user.id)
      .maybeSingle();

    if (profileRow?.must_reset_password) {
      if (!isLoginPage) window.location.replace('/pages/login.html?mustReset=1');
      return; // on login.html, leave it to login.js to show the reset form
    }

    if (isLoginPage) window.location.replace('/pages/dashboard.html');
  }

  checkSession();
})();
