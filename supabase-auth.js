(function () {
  const config = window.SUPABASE_CONFIG || {};
  const isConfigured = Boolean(config.url && config.url !== 'YOUR_SUPABASE_URL' && config.anonKey && config.anonKey !== 'YOUR_SUPABASE_ANON_KEY');

  let supabaseClient = null;
  let currentProfile = null;

  function setStatusText(element, text, type) {
    if (!element) return;
    element.textContent = text;
    element.className = `auth-message ${type}`;
  }

  function getPageName() {
    return window.location.pathname.split('/').pop() || 'index.html';
  }

  function redirectToLogin() {
    if (getPageName() !== 'login.html') window.location.href = 'login.html';
  }

  window.getSupabaseUserGroups = function (profile) {
    if (!profile) return [];
    if (Array.isArray(profile.workgroup)) {
      return profile.workgroup.map((group) => String(group).trim().toLowerCase()).filter(Boolean);
    }
    if (typeof profile.workgroup === 'string') {
      return [profile.workgroup.trim().toLowerCase()].filter(Boolean);
    }
    return [];
  };

  window.isSupabaseUserInGroup = function (profile, group) {
    const normalizedGroup = String(group || '').trim().toLowerCase();
    if (!normalizedGroup) return false;
    return window.getSupabaseUserGroups(profile).includes(normalizedGroup);
  };

  window.isSupabaseConfigured = function () {
    return isConfigured;
  };

  function ensureClient() {
    if (supabaseClient) return supabaseClient;
    if (!isConfigured || !window.supabase) return null;
    const { createClient } = window.supabase;
    supabaseClient = window.supabaseClient = createClient(config.url, config.anonKey);
    return supabaseClient;
  }

  // Loads the signed-in person's staff_users row and populates
  // window.currentSupabaseProfile (plus a cached copy in localStorage, kept
  // ONLY for pages that read it for display — the workgroup pill, the
  // header name, etc. — never as the source of truth for what someone is
  // allowed to do; that's enforced by RLS on every request now, not by this
  // cache). Column grants (see supabase-rls-lockdown.sql) mean this select
  // simply never returns password_hash/auth_email regardless of who's
  // asking, same protection as before, now for real.
  async function loadProfileForSession(session) {
    if (!session || !supabaseClient) {
      currentProfile = null;
      window.currentSupabaseProfile = null;
      localStorage.removeItem('staffProfile');
      return null;
    }

    const { data: profile, error } = await supabaseClient
      .from('staff_users')
      .select('id, username, full_name, workgroup, role, manager_id, employee_code, account_notes, active, created_at, auth_user_id, must_reset_password')
      .eq('auth_user_id', session.user.id)
      .maybeSingle();

    if (error || !profile) {
      console.warn('supabase-auth: signed in but no matching staff_users row', error);
      currentProfile = null;
      window.currentSupabaseProfile = null;
      localStorage.removeItem('staffProfile');
      return null;
    }

    currentProfile = { ...profile, uid: profile.id };
    window.currentSupabaseProfile = currentProfile;
    localStorage.setItem('staffProfile', JSON.stringify(currentProfile));
    return currentProfile;
  }

  window.signOutUser = async function () {
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
    }
    currentProfile = null;
    window.currentSupabaseProfile = null;
    localStorage.removeItem('staffProfile');
    redirectToLogin();
  };

  // Two-step sign-in, so staff keep typing their existing username (not an
  // email): get_login_email() resolves the synthetic Supabase Auth email
  // for that username (safe to call while signed out — accounts are
  // admin-created, not self-serve, so there's no signup flow whose
  // enumeration this could help), then a real password sign-in against
  // Supabase Auth issues a genuine, cryptographically verified session —
  // replacing the old model where "being signed in" was just a JSON blob
  // written to localStorage by hand.
  window.signInWithSupabase = async function (username, password, statusElement) {
    if (!isConfigured) {
      setStatusText(statusElement, 'Supabase is not configured yet. Add your URL and anon key to supabase-config.js.', 'error');
      return null;
    }

    const client = ensureClient();
    if (!client) {
      setStatusText(statusElement, 'Unable to reach the server. Try again.', 'error');
      return null;
    }

    const { data: authEmail, error: lookupError } = await client.rpc('get_login_email', { p_username: username });

    // Deliberately the same generic message whether the username doesn't
    // exist or the password would've been wrong (matches the old
    // behavior) — don't confirm which usernames are valid.
    if (lookupError || !authEmail) {
      setStatusText(statusElement, 'Incorrect username or password.', 'error');
      return null;
    }

    const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
      email: authEmail,
      password,
    });

    if (signInError || !signInData?.session) {
      setStatusText(statusElement, 'Incorrect username or password.', 'error');
      return null;
    }

    const profile = await loadProfileForSession(signInData.session);

    if (!profile) {
      await client.auth.signOut();
      setStatusText(statusElement, 'This account is not set up correctly. Please contact the IT department.', 'error');
      return null;
    }

    if (profile.active === false) {
      await client.auth.signOut();
      setStatusText(statusElement, 'This account has been deactivated. Please contact the IT department for assistance.', 'error');
      return null;
    }

    return profile;
  };

  // Account creation now goes through the create-staff-account Edge
  // Function (service-role key server-side, checks the caller is IT/Super
  // Admin from their real JWT) instead of inserting into staff_users
  // directly.
  //
  // 2026-08-19: no longer sends a caller-typed password — the Edge Function
  // generates a random one-time temp password server-side (same as
  // scripts/migrate-staff-to-auth.ts) and hands it back exactly once. The
  // returned object still has .full_name/.workgroup[0] like before, plus a
  // new .temp_password for admin-users.js to display.
  window.createSupabaseUser = async function (payload, statusElement) {
    if (!isConfigured) {
      setStatusText(statusElement, 'Supabase is not configured yet. Add your URL and anon key to supabase-config.js.', 'error');
      return null;
    }

    const client = ensureClient();
    if (!client) {
      setStatusText(statusElement, 'Unable to reach the server. Try again.', 'error');
      return null;
    }

    const { data: sessionData } = await client.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (!accessToken) {
      setStatusText(statusElement, 'Your session has expired. Please sign in again.', 'error');
      return null;
    }

    let response;
    try {
      response = await fetch(`${config.url}/functions/v1/create-staff-account`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          full_name: payload.name,
          username: payload.username,
          workgroup: payload.group || 'Operations',
        }),
      });
    } catch (networkError) {
      console.error('createSupabaseUser: network error calling Edge Function', networkError);
      setStatusText(statusElement, 'Unable to reach the server. Try again.', 'error');
      return null;
    }

    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.error) {
      setStatusText(statusElement, result.error || 'Unable to create user.', 'error');
      return null;
    }

    return { ...result.staff_user, temp_password: result.temp_password };
  };

  // Called right after supabase.auth.updateUser({ password }) succeeds on
  // the forced first-login reset (see login.js). Self-only server-side
  // (clear_must_reset_password() keys off auth.uid()), and keeps the cached
  // profile in sync so nav/UI stop prompting for a reset.
  window.clearMustResetPassword = async function () {
    const client = ensureClient();
    if (!client) return;
    await client.rpc('clear_must_reset_password');
    if (currentProfile) {
      currentProfile = { ...currentProfile, must_reset_password: false };
      window.currentSupabaseProfile = currentProfile;
      localStorage.setItem('staffProfile', JSON.stringify(currentProfile));
    }
  };

  // Keep window.currentSupabaseProfile in sync with real auth state —
  // fires once immediately with whatever session already exists (e.g.
  // navigating from one page to the next while signed in), and again on
  // future sign-in/sign-out/token-refresh events (including someone signing
  // out in another tab).
  const client = ensureClient();
  if (client) {
    client.auth.onAuthStateChange((_event, session) => {
      loadProfileForSession(session);
    });
  }
})();
