/* ============================================================================
   manager-nav.js — shows/hides the "Manage Employees" sidebar link.

   Deliberately standalone: this app has ~9 pages that each define their own
   copy of updateNavAccess() inline (some quite differently formatted), so
   rather than touching all of those, this script independently toggles
   #manageEmployeesNavItem based on the signed-in staff member's `role`
   column (added alongside payroll_employees — see
   supabase-timesheet-workflow-setup.sql) or Super Admin workgroup membership.

   Include this on any page with the shared sidebar, after supabase-auth.js.
============================================================================ */

(function () {
  function isManagerOrSuperAdmin(profile) {
    if (!profile) return false;
    const role = String(profile.role || '').trim().toLowerCase();
    const isSuperAdmin = window.isSupabaseUserInGroup
      ? window.isSupabaseUserInGroup(profile, 'Super Admin')
      : false;
    return role === 'manager' || isSuperAdmin;
  }

  function getStoredProfile() {
    if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
    try { return JSON.parse(localStorage.getItem('staffProfile') || 'null'); }
    catch { return null; }
  }

  function applyVisibility() {
    const navItem = document.getElementById('manageEmployeesNavItem');
    if (!navItem) return false;
    const profile = getStoredProfile();
    navItem.style.display = isManagerOrSuperAdmin(profile) ? 'flex' : 'none';
    return !!profile;
  }

  applyVisibility();
  document.addEventListener('DOMContentLoaded', applyVisibility);

  // Profile can arrive asynchronously after sign-in/reload (see supabase-auth.js
  // timing notes elsewhere in this app) — poll briefly until it shows up.
  let attempts = 0;
  const poll = setInterval(function () {
    attempts++;
    if (applyVisibility() || attempts > 25) clearInterval(poll);
  }, 200);
})();
