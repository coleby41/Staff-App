(function () {
  // window.location.pathname.split('/').pop() returns a bare filename with
  // no leading slash (e.g. "login.html", or just "login" once cleanUrls —
  // enabled in vercel.json — strips the extension on the deployed site), so
  // comparing it against a root-relative string like '/pages/login.html'
  // could never match. That made isLoginPage always false while actually on
  // the login page, which made every unauthenticated page-load of
  // login.html immediately redirect() to '/pages/login.html' — i.e. reload
  // itself — over and over. Normalize both sides to a bare, extensionless
  // name instead (this is the same "compare basenames, not raw paths" fix
  // already applied to project-shell.js's currentFileName() comparison).
  const lastSegment = window.location.pathname.split('/').pop() || '';
  const normalizedPage = lastSegment.replace(/\.html$/i, '');
  const isLoginPage = normalizedPage === '' || normalizedPage === 'index' || normalizedPage === 'login';

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
    //
    // This used to run its own separate `staff_users` query here — but
    // supabase-auth.js is already loading this exact row (it needs the same
    // session to populate window.currentSupabaseProfile), so this now just
    // waits for that instead of firing a second, duplicate query. Found
    // 2026-08-28 investigating a reported "everything is slow" — every
    // single page navigation in this app was quietly paying for two
    // separate round trips to staff_users for overlapping data; this cuts
    // one of them out of every page load, app-wide.
    const profileRow = await window.supabaseInitialProfilePromise;

    if (profileRow?.must_reset_password) {
      if (!isLoginPage) window.location.replace('/pages/login.html?mustReset=1');
      return; // on login.html, leave it to login.js to show the reset form
    }

    if (isLoginPage) window.location.replace('/pages/dashboard.html');
  }

  checkSession();
})();
