/* ===========================
   WORKGROUPS ADMIN PAGE
   Requires: window.supabaseClient (supabase-auth.js)

   Lets IT / Super Admin see every workgroup, add new ones, and edit which
   sidebar tabs each workgroup can see — this is the data nav-access.js
   (loaded on every other page) reads to decide what to show/hide.

   Access to THIS page is a hardcoded IT/Super-Admin-only check, not itself
   governed by the workgroup_nav_access table it manages — otherwise editing
   your own way out of this page would be possible.
=========================== */

const GOVERNABLE_TABS = [
    { key: "dashboard", label: "Dashboard" },
    { key: "excel_workbook", label: "Excel Workbook Templates" },
    { key: "form_templates", label: "Form Templates" },
    { key: "personal_finance", label: "Staff Finance" },
    { key: "project_overview", label: "Project Overview" },
    { key: "vendor_contacts", label: "Vendor Contacts" },
    { key: "payroll_tools", label: "Payroll Tools" },
    { key: "manage_employees", label: "Manage Employees *" },
    { key: "create_account", label: "Create Account" },
    { key: "staff_users", label: "Staff Users" },
    { key: "workgroups", label: "Workgroups" }
];

let workgroupRecords = [];              // [{ id, name }]
let workgroupAccessById = new Map();    // workgroup_id -> Set<nav_key>

function wgEscapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
}

function getWorkgroupsStaffProfile() {
    if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
    try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); }
    catch { return null; }
}

function isItOrSuperAdmin(profile) {
    if (!window.isSupabaseUserInGroup) return false;
    return window.isSupabaseUserInGroup(profile, "IT") || window.isSupabaseUserInGroup(profile, "Super Admin");
}

function isSuperAdminWorkgroupName(name) {
    return String(name || "").trim().toLowerCase() === "super admin";
}

function showWorkgroupsMessage(text, type) {
    const el = document.getElementById("workgroupsPageMessage");
    if (!el) return;
    el.textContent = text;
    el.className = `workbook-page-message ${type || ""}`;
    el.style.display = "block";
    if (type === "success") setTimeout(() => { el.style.display = "none"; }, 4000);
}

/* ---------- access gate ---------- */

function enforceWorkgroupsAccess() {
    const profile = getWorkgroupsStaffProfile();
    const allowed = isItOrSuperAdmin(profile);

    const content = document.getElementById("workgroupsContent");
    const restricted = document.getElementById("restrictedView");
    if (content) content.style.display = allowed ? "block" : "none";
    if (restricted) restricted.style.display = allowed ? "none" : "block";

    return allowed;
}

/* ---------- loading ---------- */

async function loadWorkgroupsData() {
    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        return;
    }

    const [{ data: groups, error: groupsError }, { data: rows, error: rowsError }] = await Promise.all([
        window.supabaseClient.from("workgroups").select("*").order("name", { ascending: true }),
        window.supabaseClient.from("workgroup_nav_access").select("workgroup_id, nav_key")
    ]);

    if (groupsError || rowsError) {
        console.error("Failed to load workgroups:", groupsError || rowsError);
        showWorkgroupsMessage("Couldn't load workgroups. Have you run supabase-workgroups-setup.sql yet?", "error");
        return;
    }

    workgroupRecords = groups || [];
    workgroupAccessById = new Map();
    (rows || []).forEach(row => {
        if (!workgroupAccessById.has(row.workgroup_id)) workgroupAccessById.set(row.workgroup_id, new Set());
        workgroupAccessById.get(row.workgroup_id).add(row.nav_key);
    });

    renderWorkgroupsList();
    renderPermissionGrid();
}

/* ---------- workgroups list (add/remove) ---------- */

function renderWorkgroupsList() {
    const list = document.getElementById("workgroupsList");
    if (!list) return;

    if (!workgroupRecords.length) {
        list.innerHTML = `<p class="workbook-preview-empty">No workgroups yet — add the first one below.</p>`;
        return;
    }

    list.innerHTML = workgroupRecords.map(wg => `
        <span class="chip chip--tag workgroup-chip" data-id="${wg.id}">
            ${wgEscapeHtml(wg.name)}
            ${isSuperAdminWorkgroupName(wg.name) ? "" : `<button type="button" class="workgroup-chip-remove" data-action="delete-workgroup" data-id="${wg.id}" aria-label="Delete ${wgEscapeHtml(wg.name)}">✕</button>`}
        </span>
    `).join("");

    list.querySelectorAll('[data-action="delete-workgroup"]').forEach(btn => {
        btn.addEventListener("click", () => openDeleteWorkgroupConfirm(btn.dataset.id));
    });
}

async function handleAddWorkgroup(event) {
    event.preventDefault();
    const input = document.getElementById("newWorkgroupNameInput");
    const name = input?.value.trim();
    if (!name) return;

    const { data, error } = await window.supabaseClient
        .from("workgroups")
        .insert({ name })
        .select()
        .single();

    if (error) {
        console.error("Failed to add workgroup:", error);
        showWorkgroupsMessage(error.code === "23505" ? `"${name}" already exists.` : "Couldn't add that workgroup. Please try again.", "error");
        return;
    }

    workgroupRecords.push(data);
    workgroupRecords.sort((a, b) => a.name.localeCompare(b.name));
    workgroupAccessById.set(data.id, new Set());
    if (input) input.value = "";

    renderWorkgroupsList();
    renderPermissionGrid();
    showWorkgroupsMessage(`"${name}" was added.`, "success");
}

let pendingDeleteWorkgroupId = null;

function openDeleteWorkgroupConfirm(id) {
    pendingDeleteWorkgroupId = id;
    const record = workgroupRecords.find(w => w.id === id);
    const messageEl = document.getElementById("deleteWorkgroupConfirmText");
    if (messageEl) messageEl.textContent = `Delete "${record?.name || "this workgroup"}"? Anyone in it will lose whatever access it granted. This can't be undone.`;
    document.getElementById("deleteWorkgroupConfirmOverlay")?.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeDeleteWorkgroupConfirm() {
    document.getElementById("deleteWorkgroupConfirmOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
    pendingDeleteWorkgroupId = null;
}

async function confirmDeleteWorkgroup() {
    if (!pendingDeleteWorkgroupId) return;
    const id = pendingDeleteWorkgroupId;

    const { error } = await window.supabaseClient.from("workgroups").delete().eq("id", id);
    if (error) {
        console.error("Failed to delete workgroup:", error);
        showWorkgroupsMessage("Couldn't delete that workgroup. Please try again.", "error");
        return;
    }

    workgroupRecords = workgroupRecords.filter(w => w.id !== id);
    workgroupAccessById.delete(id);
    closeDeleteWorkgroupConfirm();
    renderWorkgroupsList();
    renderPermissionGrid();
    showWorkgroupsMessage("Workgroup deleted.", "success");
}

/* ---------- permission grid ---------- */

function renderPermissionGrid() {
    const wrap = document.getElementById("permissionGridWrap");
    if (!wrap) return;

    if (!workgroupRecords.length) {
        wrap.innerHTML = "";
        return;
    }

    const headerCells = GOVERNABLE_TABS.map(t => `<th>${wgEscapeHtml(t.label)}</th>`).join("");

    const bodyRows = workgroupRecords.map(wg => {
        const isSuperAdmin = isSuperAdminWorkgroupName(wg.name);
        const access = workgroupAccessById.get(wg.id) || new Set();

        const cells = GOVERNABLE_TABS.map(t => {
            if (isSuperAdmin) {
                return `<td><input type="checkbox" checked disabled title="Super Admin always has full access"></td>`;
            }
            const checked = access.has(t.key) ? "checked" : "";
            return `<td><input type="checkbox" data-workgroup-id="${wg.id}" data-nav-key="${t.key}" ${checked}></td>`;
        }).join("");

        return `<tr><td class="permission-grid-workgroup-name">${wgEscapeHtml(wg.name)}</td>${cells}</tr>`;
    }).join("");

    wrap.innerHTML = `
        <table class="access-table permission-grid">
            <thead><tr><th>Workgroup</th>${headerCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
        </table>
        <p class="auth-inline-copy" style="margin-top:10px;">
            * Manage Employees is also automatically granted to anyone whose role is set to Manager, regardless of workgroup.
            Super Admin always has full access and can't be edited here.
        </p>
    `;

    wrap.querySelectorAll('input[type="checkbox"][data-workgroup-id]').forEach(cb => {
        cb.addEventListener("change", () => togglePermission(cb.dataset.workgroupId, cb.dataset.navKey, cb.checked, cb));
    });
}

async function togglePermission(workgroupId, navKey, shouldGrant, checkboxEl) {
    checkboxEl.disabled = true;

    try {
        if (shouldGrant) {
            const { error } = await window.supabaseClient
                .from("workgroup_nav_access")
                .upsert({ workgroup_id: workgroupId, nav_key: navKey }, { onConflict: "workgroup_id,nav_key", ignoreDuplicates: true });
            if (error) throw error;
            if (!workgroupAccessById.has(workgroupId)) workgroupAccessById.set(workgroupId, new Set());
            workgroupAccessById.get(workgroupId).add(navKey);
        } else {
            const { error } = await window.supabaseClient
                .from("workgroup_nav_access")
                .delete()
                .eq("workgroup_id", workgroupId)
                .eq("nav_key", navKey);
            if (error) throw error;
            workgroupAccessById.get(workgroupId)?.delete(navKey);
        }
    } catch (error) {
        console.error("Failed to update access:", error);
        checkboxEl.checked = !shouldGrant; // revert the checkbox on failure
        showWorkgroupsMessage("Couldn't save that change. Please try again.", "error");
    } finally {
        checkboxEl.disabled = false;
    }
}

/* ---------- wire up ---------- */

window.addEventListener("DOMContentLoaded", function () {
    if (!enforceWorkgroupsAccess()) return;
    loadWorkgroupsData();

    document.getElementById("addWorkgroupForm")?.addEventListener("submit", handleAddWorkgroup);
    document.getElementById("cancelDeleteWorkgroupBtn")?.addEventListener("click", closeDeleteWorkgroupConfirm);
    document.getElementById("confirmDeleteWorkgroupBtn")?.addEventListener("click", confirmDeleteWorkgroup);
    document.getElementById("deleteWorkgroupConfirmOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeDeleteWorkgroupConfirm();
    });
});
