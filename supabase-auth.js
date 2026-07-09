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

  async function hashPassword(password) {
    const passwordBuffer = new TextEncoder().encode(password);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', passwordBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function redirectToLogin() {
    if (getPageName() !== 'login.html') window.location.href = 'login.html';
  }

  function redirectToDashboard() {
    if (getPageName() !== 'index.html') window.location.href = 'index.html';
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

  async function loadProfile(username) {
    if (!supabaseClient) return null;
    const { data, error } = await supabaseClient.from('staff_users').select('*').eq('username', username).maybeSingle();
    if (error) throw error;
    return data;
  }

  window.isSupabaseConfigured = function () {
    return isConfigured;
  };

  window.signOutUser = async function () {
    currentProfile = null;
    window.currentSupabaseProfile = null;
    localStorage.removeItem('staffProfile');
    redirectToLogin();
  };

  window.signInWithSupabase = async function (username, password, statusElement) {
    if (!isConfigured) {
      setStatusText(statusElement, 'Supabase is not configured yet. Add your URL and anon key to supabase-config.js.', 'error');
      return null;
    }

    const { createClient } = window.supabase;
    supabaseClient = window.supabaseClient = createClient(config.url, config.anonKey);

    const profile = await loadProfile(username);
    if (!profile) {
      setStatusText(statusElement, 'No matching staff account was found.', 'error');
      return null;
    }

    if (profile.active === false) {
      setStatusText(statusElement, 'This account has been deactivated. Please contact the IT department for assistance.', 'error');
      return null;
    }

    const enteredHash = (await hashPassword(password)).toLowerCase();
    const storedHash = String(profile.password_hash || '').trim().toLowerCase();
    const passwordMatches = storedHash === enteredHash || storedHash === password.toLowerCase() || storedHash === password;

    if (!passwordMatches) {
      setStatusText(statusElement, 'Incorrect username or password.', 'error');
      return null;
    }

    currentProfile = { ...profile, uid: profile.id };
    window.currentSupabaseProfile = currentProfile;
    localStorage.setItem('staffProfile', JSON.stringify(currentProfile));
    return currentProfile;
  };

  window.createSupabaseUser = async function (payload, statusElement) {
    if (!isConfigured) {
      setStatusText(statusElement, 'Supabase is not configured yet. Add your URL and anon key to supabase-config.js.', 'error');
      return null;
    }

    const { createClient } = window.supabase;
    supabaseClient = window.supabaseClient = createClient(config.url, config.anonKey);

    const hashHex = await hashPassword(payload.password);

    const { data, error } = await supabaseClient.from('staff_users').insert({
      username: payload.username,
      password_hash: hashHex,
      full_name: payload.name,
      workgroup: [payload.group || 'Operations'],
      active: true
    }).select().single();

    if (error) {
      setStatusText(statusElement, error.message || 'Unable to create user.', 'error');
      return null;
    }

    return data;
  };

  if (isConfigured && window.supabase) {
    const { createClient } = window.supabase;
    supabaseClient = window.supabaseClient = createClient(config.url, config.anonKey);
}
})();
