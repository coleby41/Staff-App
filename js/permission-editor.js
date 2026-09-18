/* ===========================
   PERMISSION EDITOR POPUP (shared, every page)

   The panel that opens when someone with general.manage_workgroups
   right-clicks a sidebar tab (wired in js/nav-access.js). Lists every
   permission that belongs to that one page (js/permissions.js's
   permissionsForPage()) and lets you flip any workgroup's access to any of
   them right there, without leaving the page you're on. Same underlying
   grant/revoke calls, and the same live data, as the full grid on the
   Workgroups screen (workgroups.js) -- this is just a page-scoped window
   into the exact same table.

   A permission whose governed_by is 'project_role' (Project Accounts,
   Project Files, Project Timeline, Project To-Do) shows a plain note
   instead of checkboxes -- those are controlled per-project by that
   project's own member roles, not by workgroup, so faking checkboxes for
   them here would be lying about what actually controls access.
=========================== */

const PERMISSION_EDITOR_WORKGROUP_ORDER = ["Super Admin", "Owner", "IT", "Office", "Accounting", "Field", "Operations"];

let permissionEditorWorkgroups = null; // [{ id, name }], loaded once and cached for the life of the page

function peEscapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
}

async function loadPermissionEditorWorkgroups() {
    if (permissionEditorWorkgroups) return permissionEditorWorkgroups;
    const { data, error } = await window.supabaseClient.from("workgroups").select("id, name");
    if (error) throw error;
    const byName = new Map((data || []).map(w => [w.name, w]));
    // stable, sensible order rather than whatever order the database returns
    permissionEditorWorkgroups = PERMISSION_EDITOR_WORKGROUP_ORDER
        .filter(name => byName.has(name))
        .map(name => byName.get(name));
    // anything not in the known order list (a custom workgroup Coleby added) goes at the end
    (data || []).forEach(w => { if (!PERMISSION_EDITOR_WORKGROUP_ORDER.includes(w.name)) permissionEditorWorkgroups.push(w); });
    return permissionEditorWorkgroups;
}

function closePermissionEditorPopup() {
    document.getElementById("permissionEditorPopup")?.remove();
    document.removeEventListener("click", handlePermissionEditorOutsideClick, true);
    document.removeEventListener("keydown", handlePermissionEditorEscape, true);
}

function handlePermissionEditorOutsideClick(event) {
    const popup = document.getElementById("permissionEditorPopup");
    if (popup && !popup.contains(event.target)) closePermissionEditorPopup();
}

function handlePermissionEditorEscape(event) {
    if (event.key === "Escape") closePermissionEditorPopup();
}

function permissionEditorRowHtml(permission, workgroups) {
    if (permission.governed_by === "project_role") {
        return `
            <div class="permission-editor-row permission-editor-row--note">
                <div class="permission-editor-row-label">
                    <div class="permission-editor-row-name">${peEscapeHtml(permission.label)}</div>
                    <div class="permission-editor-row-desc">${peEscapeHtml(permission.description || "")}</div>
                </div>
                <div class="permission-editor-row-note">Set per-project (Project Members), not by workgroup</div>
            </div>
        `;
    }

    const granted = window.Permissions.workgroupsWithPermission(permission.key);
    const chips = workgroups.map(wg => {
        const isSuperAdmin = wg.name === "Super Admin";
        const checked = isSuperAdmin || granted.has(wg.name.trim().toLowerCase());
        return `
            <label class="permission-editor-chip ${checked ? "is-checked" : ""} ${isSuperAdmin ? "is-locked" : ""}" title="${isSuperAdmin ? "Super Admin always has every permission" : ""}">
                <input type="checkbox" data-workgroup-id="${wg.id}" data-workgroup-name="${peEscapeHtml(wg.name)}" data-permission-key="${permission.key}" ${checked ? "checked" : ""} ${isSuperAdmin ? "disabled" : ""}>
                ${peEscapeHtml(wg.name)}
            </label>
        `;
    }).join("");

    return `
        <div class="permission-editor-row">
            <div class="permission-editor-row-label">
                <div class="permission-editor-row-name">${peEscapeHtml(permission.label)}</div>
                <div class="permission-editor-row-desc">${peEscapeHtml(permission.description || "")}</div>
            </div>
            <div class="permission-editor-chip-row">${chips}</div>
        </div>
    `;
}

async function togglePermissionEditorCheckbox(checkboxEl) {
    const workgroupId = checkboxEl.dataset.workgroupId;
    const workgroupName = checkboxEl.dataset.workgroupName;
    const permissionKey = checkboxEl.dataset.permissionKey;
    const shouldGrant = checkboxEl.checked;

    checkboxEl.disabled = true;
    try {
        if (shouldGrant) await window.Permissions.grantPermission(workgroupId, permissionKey);
        else await window.Permissions.revokePermission(workgroupId, permissionKey);
        window.Permissions.applyPermissionChangeToCache(workgroupName, permissionKey, shouldGrant);
        checkboxEl.closest(".permission-editor-chip")?.classList.toggle("is-checked", shouldGrant);
    } catch (error) {
        console.error("Failed to update permission:", error);
        checkboxEl.checked = !shouldGrant; // revert on failure
        const messageEl = document.getElementById("permissionEditorMessage");
        if (messageEl) { messageEl.textContent = "Couldn't save that change. Please try again."; messageEl.className = "auth-message error"; }
    } finally {
        checkboxEl.disabled = false;
    }
}

async function openPermissionEditorPopup(pageLabel, clientX, clientY) {
    closePermissionEditorPopup();

    const popup = document.createElement("div");
    popup.id = "permissionEditorPopup";
    popup.className = "permission-editor-popup";
    popup.innerHTML = `
        <div class="permission-editor-header">
            <h3>${peEscapeHtml(pageLabel)}</h3>
            <button type="button" class="permission-editor-close" aria-label="Close">✕</button>
        </div>
        <p class="auth-message" id="permissionEditorMessage"></p>
        <div class="permission-editor-body">Loading…</div>
    `;
    document.body.appendChild(popup);

    // Position, clamped to the viewport (same approach used elsewhere in
    // this app for fixed-position popovers, e.g. positionPdfPopover).
    const margin = 12;
    const rect = popup.getBoundingClientRect();
    let left = clientX;
    let top = clientY;
    if (left + rect.width + margin > window.innerWidth) left = Math.max(margin, window.innerWidth - rect.width - margin);
    if (top + rect.height + margin > window.innerHeight) top = Math.max(margin, window.innerHeight - rect.height - margin);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;

    popup.querySelector(".permission-editor-close")?.addEventListener("click", closePermissionEditorPopup);
    document.addEventListener("click", handlePermissionEditorOutsideClick, true);
    document.addEventListener("keydown", handlePermissionEditorEscape, true);

    try {
        const [workgroups] = await Promise.all([
            loadPermissionEditorWorkgroups(),
            window.Permissions.initPermissions(),
        ]);
        const permissions = window.Permissions.permissionsForPage(pageLabel);
        const body = popup.querySelector(".permission-editor-body");
        if (!permissions.length) {
            body.innerHTML = `<p class="workbook-preview-empty">No individually-listed permissions for this page yet.</p>`;
        } else {
            body.innerHTML = permissions.map(p => permissionEditorRowHtml(p, workgroups)).join("");
            body.querySelectorAll('input[type="checkbox"][data-permission-key]').forEach(cb => {
                cb.addEventListener("change", () => togglePermissionEditorCheckbox(cb));
            });
        }
        // re-clamp position now that real content has replaced "Loading…"
        const rect2 = popup.getBoundingClientRect();
        let left2 = parseFloat(popup.style.left);
        let top2 = parseFloat(popup.style.top);
        if (left2 + rect2.width + margin > window.innerWidth) left2 = Math.max(margin, window.innerWidth - rect2.width - margin);
        if (top2 + rect2.height + margin > window.innerHeight) top2 = Math.max(margin, window.innerHeight - rect2.height - margin);
        popup.style.left = `${left2}px`;
        popup.style.top = `${top2}px`;
    } catch (error) {
        console.error("Failed to load permission editor:", error);
        popup.querySelector(".permission-editor-body").innerHTML = `<p class="auth-message error">Couldn't load permissions. Please try again.</p>`;
    }
}

window.PermissionEditor = { open: openPermissionEditorPopup, close: closePermissionEditorPopup };
