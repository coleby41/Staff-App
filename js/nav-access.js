/* ===========================
   NAV ACCESS (shared, every page)

   Reads the permissions / workgroup_permissions tables (see
   sql/supabase-permissions-system-setup.sql, via js/permissions.js) and,
   based on the signed-in staff member's workgroup(s), shows/hides the
   sidebar tabs they don't have access to, and gates the current page's own
   content the same way.

   2026-09-18: rewritten to read the new granular permissions system instead
   of the old workgroup_nav_access table -- "tab access" is no longer its
   own separate concept, it's just whichever general.view_* permission
   corresponds to that tab, managed in the exact same place (and the exact
   same right-click-the-tab popup, see js/permission-editor.js) as every
   other permission on that page. workgroup_nav_access itself is left alone
   in the database (not dropped) in case anything else still reads it, but
   nothing in the app queries it anymore as of this change.

   IMPORTANT -- fails open on purpose, same as before: if permissions/
   workgroup_permissions don't exist yet (the SQL hasn't been run), every
   check answers true (see js/permissions.js's own fail-open behavior) and
   nothing changes for anyone until the migration has actually run.

   "Super Admin" always has full access, and "Manager" (staff_users.role)
   always additionally gets Manage Employees -- both handled inside
   Permissions.hasPermission() now, not duplicated here.

   RIGHT-CLICK TO EDIT: anyone with general.manage_workgroups gets a
   right-click (contextmenu) handler on every visible nav link, opening a
   small popup (js/permission-editor.js) scoped to that one page's
   permissions -- the same underlying grant/revoke as the full Workgroups
   screen, just without leaving the page you're looking at. Disabled while
   previewing another workgroup (see PREVIEW MODE below), since that's a
   look-only mode.

   PREVIEW MODE: when js/permissions.js reports a preview workgroup is
   active (set from the Workgroups screen's "Preview" button), this script
   renders every tab exactly as that workgroup would see it and shows a
   dismissible banner at the top of the page so it's never ambiguous that
   you're looking at someone else's view, not your own.
=========================== */

const NAV_ITEMS = [
    { key: "dashboard", selector: 'a[href="/pages/dashboard.html"]', permission: "general.view_dashboard", pageLabel: "Dashboard" },
    { key: "excel_workbook", selector: 'a[href="/pages/excel-workbook.html"]', permission: "general.view_excel_workbook_templates", pageLabel: "Excel Workbook Templates" },
    { key: "form_templates", selector: 'a[href="/pages/form-template.html"]', permission: "general.view_form_templates", pageLabel: "Form Templates" },
    { key: "personal_finance", selector: 'a[href="/pages/timesheet.html"]', permission: "general.view_personal_finance", pageLabel: "Personal Finance (Timesheet)" },
    { key: "vendor_contacts", selector: 'a[href="/pages/vendors.html"]', permission: "general.view_vendor_contacts", pageLabel: "Vendor Contacts" },
    { key: "payroll_tools", selector: 'a[href="/pages/payroll-tools.html"]', permission: "general.view_payroll_tools", pageLabel: "Payroll Tools" },
    { key: "manage_employees", selector: 'a[href="/pages/manage-employees.html"]', permission: "general.view_manage_employees", pageLabel: "Manage Employees" },
    { key: "create_account", selector: '.subnav a[href="/pages/admin-users.html"]', permission: "general.create_staff_account", pageLabel: "Create Account" },
    { key: "staff_users", selector: 'a[href="/pages/staff-users.html"]', permission: "general.view_staff_users", pageLabel: "Staff Users" },
    { key: "workgroups", selector: 'a[href="/pages/workgroups.html"]', permission: "general.manage_workgroups", pageLabel: "Workgroups" },
    { key: "project_overview", selector: 'a[href="/pages/project-home.html"]', permission: "general.view_project_overview", pageLabel: "Project Overview" }
];

// Bare, extensionless page name -> the NAV_ITEMS entry that page represents,
// so this script can gate the CURRENT page's own content too, not just hide
// sidebar links to it. Keyed on a normalized basename (see
// navAccessCurrentFileName() below) rather than a root-relative path -- see
// the long-standing comment history on this in git blame if curious why.
const PATH_TO_NAV_KEY = {
    "dashboard": "dashboard",
    "excel-workbook": "excel_workbook",
    "form-template": "form_templates",
    "timesheet": "personal_finance",
    "vendors": "vendor_contacts",
    "payroll-tools": "payroll_tools",
    "manage-employees": "manage_employees",
    "admin-users": "create_account",
    "staff-users": "staff_users",
    "workgroups": "workgroups",
    "project-home": "project_overview"
};

// A few pages already have their own "restricted view" markup (built before
// this system existed) -- reuse those instead of redirecting away, since
// that's a nicer experience than a jarring bounce to the dashboard.
const PAGE_CONTENT_GATES = {
    payroll_tools: { contentId: "payrollToolsContent", restrictedId: "restrictedView" },
    manage_employees: { contentId: "manageEmployeesContent", restrictedId: "restrictedView" }
};

function navAccessCurrentFileName() {
    const lastSegment = decodeURIComponent(window.location.pathname.split("/").pop() || "");
    return lastSegment.replace(/\.html$/i, "");
}

function computeAccessibleKeys() {
    const keys = new Set();
    NAV_ITEMS.forEach(item => {
        if (window.Permissions.hasPermission(item.permission)) keys.add(item.key);
    });
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
    const key = PATH_TO_NAV_KEY[navAccessCurrentFileName()];
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

    // No restricted-view markup on this page -- the only sensible fallback
    // is to send them somewhere they do have access. Guard against ever
    // redirecting away from dashboard.html itself (it's granted to every
    // seeded workgroup, so this should never actually trigger).
    if (!hasAccess && key !== "dashboard") {
        window.location.replace("/pages/dashboard.html");
    }
}

/* ---------- right-click to edit (see js/permission-editor.js) ---------- */

function wireRightClickEditors() {
    // Disabled entirely while previewing another workgroup -- preview is a
    // look-only mode, editing belongs to your own real access.
    if (window.Permissions.isPermissionPreviewActive()) return;
    if (!window.Permissions.hasPermission("general.manage_workgroups")) return;
    if (!window.PermissionEditor) return;

    NAV_ITEMS.forEach(item => {
        document.querySelectorAll(item.selector).forEach(el => {
            el.addEventListener("contextmenu", function (event) {
                event.preventDefault();
                window.PermissionEditor.open(item.pageLabel, event.clientX, event.clientY);
            });
        });
    });
}

/* ---------- preview-mode banner ---------- */

function renderPreviewBanner() {
    const preview = window.Permissions.getPermissionPreview();
    const existing = document.getElementById("permissionPreviewBanner");
    if (!preview) {
        if (existing) existing.remove();
        return;
    }
    if (existing) return; // already showing

    const banner = document.createElement("div");
    banner.id = "permissionPreviewBanner";
    banner.className = "permission-preview-banner";
    banner.innerHTML = `
        <span>Previewing as <strong>${(preview.name || "").replace(/</g, "&lt;")}</strong> — this is what that workgroup sees, not your own access.</span>
        <button type="button" id="exitPermissionPreviewBtn">Exit Preview</button>
    `;
    document.body.prepend(banner);
    document.getElementById("exitPermissionPreviewBtn")?.addEventListener("click", () => window.Permissions.exitPermissionPreview());
}

async function initNavAccess() {
    if (!window.supabaseClient || !window.Permissions) return;

    await window.Permissions.initPermissions();

    const keys = computeAccessibleKeys();

    applyNavItemVisibility(keys);
    applyGroupWrapperVisibility("companyDocsNavGroup");
    applyGroupWrapperVisibility("adminNavGroup");
    applyCurrentPageGate(keys);
    renderPreviewBanner();
    wireRightClickEditors();

    window.NavAccessKeys = keys;
}

// Same "poll briefly for the profile/client to be ready" pattern used
// elsewhere in this app (notifications.js, timesheet.js's pollForProfile).
function pollAndInitNavAccess(attempts) {
    attempts = attempts || 0;
    const clientReady = !!window.supabaseClient;
    const profileReady = !!(window.currentSupabaseProfile || localStorage.getItem("staffProfile"));

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
