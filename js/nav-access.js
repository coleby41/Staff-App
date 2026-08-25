/* ===========================
   NAV ACCESS (shared, every page)

   Reads the workgroups / workgroup_nav_access tables (see
   supabase-workgroups-setup.sql) and, based on the signed-in staff member's
   workgroup(s), shows/hides the sidebar tabs they don't have access to, and
   gates the current page's own content the same way. This replaces the
   ~10 separate hand-copied "updateNavAccess()" functions that used to live
   inline in every page with one real, editable source of truth.

   IMPORTANT — fails open on purpose: if workgroups/workgroup_nav_access
   don't exist yet (the SQL hasn't been run), this script does nothing at
   all and leaves every page's existing hardcoded checks exactly as they
   were. Nothing changes for anyone until the migration has actually run.
   Once it has, this becomes the authoritative source.

   "Super Admin" always has full access, regardless of what's configured in
   workgroup_nav_access — this is a hardcoded bypass, not editable from the
   Workgroups page, so it's not possible to accidentally lock every admin
   out of the app.

   "Manage Employees" is additive: this script grants it exactly as before
   (workgroup access, if configured) but ALSO keeps granting it to anyone
   whose staff_users.role is 'Manager', matching the existing
   manager-nav.js behavior, since that's a per-person attribute rather than
   a workgroup one.
=========================== */

const NAV_ITEMS = [
    { key: "dashboard", selector: 'a[href="/pages/dashboard.html"]' },
    { key: "excel_workbook", selector: 'a[href="/pages/excel-workbook.html"]' },
    { key: "form_templates", selector: 'a[href="/pages/form-template.html"]' },
    { key: "personal_finance", selector: 'a[href="/pages/timesheet.html"]' },
    { key: "vendor_contacts", selector: 'a[href="/pages/vendors.html"]' },
    { key: "payroll_tools", selector: 'a[href="/pages/payroll-tools.html"]' },
    { key: "manage_employees", selector: 'a[href="/pages/manage-employees.html"]' },
    { key: "create_account", selector: '.subnav a[href="/pages/admin-users.html"]' },
    { key: "staff_users", selector: 'a[href="/pages/staff-users.html"]' },
    { key: "workgroups", selector: 'a[href="/pages/workgroups.html"]' },
    { key: "project_overview", selector: 'a[href="/pages/project-home.html"]' }
];

// Filename (as it appears in location.pathname) -> the nav key that page
// represents, so this script can gate the CURRENT page's own content too,
// not just hide sidebar links to it.
const PATH_TO_KEY = {
    "/pages/dashboard.html": "dashboard",
    "/pages/excel-workbook.html": "excel_workbook",
    "/pages/form-template.html": "form_templates",
    "/pages/timesheet.html": "personal_finance",
    "/pages/vendors.html": "vendor_contacts",
    "/pages/payroll-tools.html": "payroll_tools",
    "/pages/manage-employees.html": "manage_employees",
    "/pages/admin-users.html": "create_account",
    "/pages/staff-users.html": "staff_users",
    "/pages/workgroups.html": "workgroups",
    "/pages/project-home.html": "project_overview"
};

// A few pages already have their own "restricted view" markup (built before
// this system existed) — reuse those instead of redirecting away, since
// that's a nicer experience than a jarring bounce to the dashboard.
const PAGE_CONTENT_GATES = {
    payroll_tools: { contentId: "payrollToolsContent", restrictedId: "restrictedView" },
    manage_employees: { contentId: "manageEmployeesContent", restrictedId: "restrictedView" }
};

function navAccessGetProfile() {
    if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
    try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); }
    catch { return null; }
}

function navAccessIsSuperAdmin(profile) {
    return window.isSupabaseUserInGroup ? window.isSupabaseUserInGroup(profile, "Super Admin") : false;
}

function navAccessIsManagerRole(profile) {
    return String(profile?.role || "").trim().toLowerCase() === "manager";
}

function navAccessCurrentFileName() {
    return decodeURIComponent(window.location.pathname.split("/").pop() || "");
}

async function loadWorkgroupAccessMap() {
    const [{ data: groups, error: groupsError }, { data: rows, error: rowsError }] = await Promise.all([
        window.supabaseClient.from("workgroups").select("id, name"),
        window.supabaseClient.from("workgroup_nav_access").select("workgroup_id, nav_key")
    ]);

    if (groupsError || rowsError) {
        throw groupsError || rowsError;
    }

    const idToName = new Map((groups || []).map(g => [g.id, String(g.name || "").trim().toLowerCase()]));
    const map = new Map(); // lowercase workgroup name -> Set<nav_key>

    (rows || []).forEach(row => {
        const name = idToName.get(row.workgroup_id);
        if (!name) return;
        if (!map.has(name)) map.set(name, new Set());
        map.get(name).add(row.nav_key);
    });

    return map;
}

function computeAccessibleKeys(profile, accessMap) {
    const keys = new Set();

    if (navAccessIsSuperAdmin(profile)) {
        NAV_ITEMS.forEach(item => keys.add(item.key));
        return keys;
    }

    const groups = window.getSupabaseUserGroups ? window.getSupabaseUserGroups(profile) : [];
    groups.forEach(g => {
        const set = accessMap.get(g);
        if (set) set.forEach(k => keys.add(k));
    });

    if (navAccessIsManagerRole(profile)) keys.add("manage_employees");

    return keys;
}

function applyNavItemVisibility(keys) {
    NAV_ITEMS.forEach(item => {
        document.querySelectorAll(item.selector).forEach(el => {
            el.style.display = keys.has(item.key) ? "" : "none";
        });
    });
}

// Shows/hides an entire nav-item-group wrapper (e.g. "Company docs", "IT
// Tools") based on whether any of its own subnav links are currently
// visible, so a group doesn't sit there empty with every child hidden.
function applyGroupWrapperVisibility(groupId) {
    const group = document.getElementById(groupId);
    if (!group) return;
    const children = group.querySelectorAll(".subnav a");
    const anyVisible = Array.from(children).some(el => el.style.display !== "none");
    group.style.display = anyVisible ? "" : "none";
}

function applyCurrentPageGate(keys) {
    const key = PATH_TO_KEY[navAccessCurrentFileName()];
    if (!key) return;

    const hasAccess = keys.has(key);
    const gate = PAGE_CONTENT_GATES[key];

    if (gate) {
        const contentEl = document.getElementById(gate.contentId);
        const restrictedEl = document.getElementById(gate.restrictedId);
        if (contentEl) contentEl.style.display = hasAccess ? "" : "none";
        if (restrictedEl) restrictedEl.style.display = hasAccess ? "none" : "block";
        return;
    }

    // No restricted-view markup on this page — the only sensible fallback
    // is to send them somewhere they do have access. Guard against ever
    // redirecting away from dashboard.html itself (it's granted to every
    // seeded workgroup, so this should never actually trigger).
    if (!hasAccess && key !== "dashboard") {
        window.location.replace("/pages/dashboard.html");
    }
}

async function initNavAccess() {
    if (!window.supabaseClient) return;

    let accessMap;
    try {
        accessMap = await loadWorkgroupAccessMap();
    } catch (error) {
        // Fail open: tables probably don't exist yet (SQL not run). Leave
        // every page's existing hardcoded checks in charge, untouched.
        console.warn("nav-access: workgroups/workgroup_nav_access not available yet, leaving existing access checks in place.", error);
        return;
    }

    const profile = navAccessGetProfile();
    const keys = computeAccessibleKeys(profile, accessMap);

    applyNavItemVisibility(keys);
    applyGroupWrapperVisibility("companyDocsNavGroup");
    applyGroupWrapperVisibility("adminNavGroup");
    applyCurrentPageGate(keys);

    window.NavAccessKeys = keys;
}

// Same "poll briefly for the profile/client to be ready" pattern used
// elsewhere in this app (notifications.js, timesheet.js's pollForProfile).
function pollAndInitNavAccess(attempts) {
    attempts = attempts || 0;
    const clientReady = !!window.supabaseClient;
    const profileReady = !!navAccessGetProfile();

    if (clientReady && (profileReady || attempts >= 25)) {
        initNavAccess();
        return;
    }
    if (attempts >= 25) {
        if (clientReady) initNavAccess();
        return;
    }
    setTimeout(function () { pollAndInitNavAccess(attempts + 1); }, 200);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { pollAndInitNavAccess(); });
} else {
    pollAndInitNavAccess();
}
