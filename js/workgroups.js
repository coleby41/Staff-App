/* ===========================
   WORKGROUPS (ROLES & PERMISSIONS) ADMIN PAGE
   Requires: window.supabaseClient (supabase-auth.js), window.Permissions (permissions.js)

   Lets IT / Super Admin see every workgroup, add new ones, and edit every
   individual permission each workgroup has -- not just whole sidebar tabs
   anymore (2026-09-18 rewrite). Reads/writes the same permissions /
   workgroup_permissions tables as the per-page right-click editor
   (js/permission-editor.js); this screen is just the full, browse-everything
   view of the same data, plus workgroup add/delete and "Preview" (see
   below).

   Access to THIS page is a hardcoded IT/Super-Admin-only check, not itself
   governed by the permissions table it manages -- otherwise editing your
   own way out of this page would be possible.

   PREVIEW: clicking "Preview" on a workgroup puts the browser into preview
   mode (js/permissions.js) and sends you to the dashboard as that
   workgroup would see it -- real tabs shown/hidden, real page content
   gated, exactly like actually being a member of it. A banner (rendered by
   nav-access.js on every page) makes it obvious you're previewing and
   offers a one-click way back.
=========================== */

let workgroupRecords = [];      // [{ id, name }]
let selectedWorkgroupId = null;
let permissionsCatalogByCategory = null; // Map<category, [{key,label,description,governed_by,page_label}]>

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

function groupPermissionsByCategory() {
    const map = new Map();
    window.Permissions.getPermissionsCatalog().forEach(p => {
        if (!map.has(p.category)) map.set(p.category, []);
        map.get(p.category).push(p);
    });
    permissionsCatalogByCategory = map;
}

async function loadWorkgroupsData() {
    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        return;
    }

    const { data: groups, error: groupsError } = await window.supabaseClient
        .from("workgroups").select("*").order("name", { ascending: true });

    if (groupsError) {
        console.error("Failed to load workgroups:", groupsError);
        showWorkgroupsMessage("Couldn't load workgroups. Have you run supabase-workgroups-setup.sql yet?", "error");
        return;
    }

    workgroupRecords = groups || [];

    try {
        await window.Permissions.initPermissions();
        groupPermissionsByCategory();
    } catch (error) {
        console.error("Failed to load permissions catalog:", error);
        showWorkgroupsMessage("Couldn't load the permission catalog. Have you run supabase-permissions-system-setup.sql yet?", "error");
        return;
    }

    renderWorkgroupsList();
    if (!selectedWorkgroupId && workgroupRecords.length) selectedWorkgroupId = workgroupRecords[0].id;
    renderPermissionPanel();
}

/* ---------- workgroups list (add/remove/select) ---------- */

function renderWorkgroupsList() {
    const list = document.getElementById("workgroupsList");
    if (!list) return;

    if (!workgroupRecords.length) {
        list.innerHTML = `<p class="workbook-preview-empty">No workgroups yet — add the first one below.</p>`;
        return;
    }

    list.innerHTML = workgroupRecords.map(wg => `
        <div class="workgroup-list-row ${wg.id === selectedWorkgroupId ? "is-selected" : ""}" data-id="${wg.id}">
            <button type="button" class="workgroup-list-row-name" data-action="select-workgroup" data-id="${wg.id}">${wgEscapeHtml(wg.name)}</button>
            <button type="button" class="workbook-btn workbook-btn--preview workgroup-preview-btn" data-action="preview-workgroup" data-id="${wg.id}" title="See the app as this workgroup would see it">Preview</button>
            ${isSuperAdminWorkgroupName(wg.name) ? "" : `<button type="button" class="workgroup-chip-remove" data-action="delete-workgroup" data-id="${wg.id}" aria-label="Delete ${wgEscapeHtml(wg.name)}">✕</button>`}
        </div>
    `).join("");

    list.querySelectorAll('[data-action="select-workgroup"]').forEach(btn => {
        btn.addEventListener("click", () => { selectedWorkgroupId = btn.dataset.id; renderWorkgroupsList(); renderPermissionPanel(); });
    });
    list.querySelectorAll('[data-action="preview-workgroup"]').forEach(btn => {
        btn.addEventListener("click", () => {
            const wg = workgroupRecords.find(w => w.id === btn.dataset.id);
            if (wg) window.Permissions.startPermissionPreview(wg.id, wg.name);
        });
    });
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
    selectedWorkgroupId = data.id;
    if (input) input.value = "";

    renderWorkgroupsList();
    renderPermissionPanel();
    showWorkgroupsMessage(`"${name}" was added.`, "success");
}

let pendingDeleteWorkgroupId = null;
let pendingDeleteWorkgroupName = "";

// Typing the workgroup's own name to confirm (same pattern used for project
// deletion) -- cheap insurance against a one-click delete landing on the
// wrong workgroup, which is otherwise unrecoverable.
function deleteWorkgroupConfirmNameMatches() {
    const typed = document.getElementById("deleteWorkgroupConfirmNameInput").value;
    return pendingDeleteWorkgroupName.length > 0 && typed.trim() === pendingDeleteWorkgroupName;
}

function deleteWorkgroupConfirmReady() {
    return deleteWorkgroupConfirmNameMatches()
        && document.getElementById("deleteWorkgroupConfirmUnderstandCheckbox").checked;
}

function updateDeleteWorkgroupConfirmBtnState() {
    document.getElementById("confirmDeleteWorkgroupBtn").disabled = !deleteWorkgroupConfirmReady();
}

function openDeleteWorkgroupConfirm(id) {
    pendingDeleteWorkgroupId = id;
    const record = workgroupRecords.find(w => w.id === id);
    pendingDeleteWorkgroupName = record?.name || "";
    document.getElementById("deleteWorkgroupConfirmName").textContent = pendingDeleteWorkgroupName || "this workgroup";
    const messageEl = document.getElementById("deleteWorkgroupConfirmText");
    if (messageEl) messageEl.textContent = "Anyone in it will lose whatever access it granted. This can't be undone.";
    const input = document.getElementById("deleteWorkgroupConfirmNameInput");
    input.value = "";
    document.getElementById("deleteWorkgroupConfirmUnderstandCheckbox").checked = false;
    document.getElementById("deleteWorkgroupConfirmMessage").textContent = "";
    document.getElementById("deleteWorkgroupConfirmOverlay")?.classList.remove("hidden");
    document.body.classList.add("popup-active");
    updateDeleteWorkgroupConfirmBtnState();
    input.focus();
}

function closeDeleteWorkgroupConfirm() {
    document.getElementById("deleteWorkgroupConfirmOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
    pendingDeleteWorkgroupId = null;
    pendingDeleteWorkgroupName = "";
}

async function confirmDeleteWorkgroup() {
    if (!pendingDeleteWorkgroupId) return;
    if (!deleteWorkgroupConfirmReady()) return;
    const id = pendingDeleteWorkgroupId;

    const { error } = await window.supabaseClient.from("workgroups").delete().eq("id", id);
    if (error) {
        console.error("Failed to delete workgroup:", error);
        showWorkgroupsMessage("Couldn't delete that workgroup. Please try again.", "error");
        return;
    }

    workgroupRecords = workgroupRecords.filter(w => w.id !== id);
    if (selectedWorkgroupId === id) selectedWorkgroupId = workgroupRecords[0]?.id || null;
    closeDeleteWorkgroupConfirm();
    renderWorkgroupsList();
    renderPermissionPanel();
    showWorkgroupsMessage("Workgroup deleted.", "success");
}

/* ---------- selected workgroup's permission panel ---------- */

function renderPermissionPanel() {
    const wrap = document.getElementById("permissionPanelWrap");
    if (!wrap) return;

    const wg = workgroupRecords.find(w => w.id === selectedWorkgroupId);
    if (!wg) {
        wrap.innerHTML = "";
        return;
    }

    const isSuperAdmin = isSuperAdminWorkgroupName(wg.name);
    const categories = Array.from(permissionsCatalogByCategory.keys());

    const categoriesHtml = categories.map(category => {
        const rows = permissionsCatalogByCategory.get(category).map(p => permissionPanelRowHtml(p, wg, isSuperAdmin)).join("");
        return `
            <div class="permission-panel-category">
                <h4>${wgEscapeHtml(category)}</h4>
                ${rows}
            </div>
        `;
    }).join("");

    wrap.innerHTML = `
        <div class="permission-panel-header">
            <h3>${wgEscapeHtml(wg.name)}</h3>
            ${isSuperAdmin ? `<p class="auth-inline-copy">Super Admin always has every permission and can't be edited here.</p>` : ""}
        </div>
        ${categoriesHtml}
    `;

    if (!isSuperAdmin) {
        wrap.querySelectorAll('input[type="checkbox"][data-permission-key]').forEach(cb => {
            cb.addEventListener("change", () => toggleWorkgroupPermission(cb));
        });
    }
}

function permissionPanelRowHtml(permission, wg, isSuperAdmin) {
    if (permission.governed_by === "project_role") {
        return `
            <div class="permission-panel-row permission-panel-row--note">
                <div class="permission-panel-row-label">
                    <div class="permission-panel-row-name">${wgEscapeHtml(permission.label)}</div>
                    <div class="permission-panel-row-desc">${wgEscapeHtml(permission.description || "")}</div>
                </div>
                <div class="permission-panel-row-note">Set per-project (Project Members)</div>
            </div>
        `;
    }

    const granted = window.Permissions.workgroupsWithPermission(permission.key);
    const checked = isSuperAdmin || granted.has(wg.name.trim().toLowerCase());

    return `
        <div class="permission-panel-row">
            <div class="permission-panel-row-label">
                <div class="permission-panel-row-name">${wgEscapeHtml(permission.label)}</div>
                <div class="permission-panel-row-desc">${wgEscapeHtml(permission.description || "")}</div>
            </div>
            <label class="permission-panel-toggle">
                <input type="checkbox" data-workgroup-id="${wg.id}" data-workgroup-name="${wgEscapeHtml(wg.name)}" data-permission-key="${permission.key}" ${checked ? "checked" : ""} ${isSuperAdmin ? "disabled" : ""}>
                <span class="permission-panel-toggle-track"></span>
            </label>
        </div>
    `;
}

async function toggleWorkgroupPermission(checkboxEl) {
    checkboxEl.disabled = true;
    const workgroupId = checkboxEl.dataset.workgroupId;
    const workgroupName = checkboxEl.dataset.workgroupName;
    const permissionKey = checkboxEl.dataset.permissionKey;
    const shouldGrant = checkboxEl.checked;

    try {
        if (shouldGrant) await window.Permissions.grantPermission(workgroupId, permissionKey);
        else await window.Permissions.revokePermission(workgroupId, permissionKey);
        window.Permissions.applyPermissionChangeToCache(workgroupName, permissionKey, shouldGrant);
    } catch (error) {
        console.error("Failed to update permission:", error);
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
    document.getElementById("deleteWorkgroupConfirmNameInput")?.addEventListener("input", updateDeleteWorkgroupConfirmBtnState);
    document.getElementById("deleteWorkgroupConfirmUnderstandCheckbox")?.addEventListener("change", updateDeleteWorkgroupConfirmBtnState);
});
