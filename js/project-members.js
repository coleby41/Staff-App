/* ===========================
   PROJECT MEMBERS (pages/project-home.html)
   Right-click a project card -> "Project Members" popup. Add staff to that
   one project, set their per-project role, toggle financial visibility, or
   remove them. Reads/writes public.project_members (see
   sql/supabase-auth-rearchitecture-schema.sql) -- that table existed since
   the security re-architecture but nothing in the app ever managed it.

   project_members.user_id is the AUTH user id (auth.users), not
   staff_users.id, so staff are matched up via staff_users.auth_user_id.
   Staff without an auth_user_id (never migrated to Supabase Auth) can't be
   added and are left out of the picker.

   Who can edit: Super Admin, IT, or anyone who is a project_admin on THIS
   project. Everyone else can open it read-only. This is a UI gate only --
   the project_members RLS policies are open to every signed-in staff member
   (supabase-flatten-project-permissions-to-all-staff.sql), same as every
   other project table right now.

   Popup markup is injected here (not in project-home.html) so this whole
   feature lives in one file. Self-initializing; loaded after projects-page.js.
=========================== */
(function () {
    const PM_ROLES = [
        { key: "project_admin",   label: "Project Admin",   desc: "Full control, including managing members" },
        { key: "project_manager", label: "Project Manager", desc: "Runs the project day to day" },
        { key: "accounting",      label: "Accounting",      desc: "Accounting access on this project" },
        { key: "staff",           label: "Staff",           desc: "Standard project access" },
        { key: "viewer",          label: "Viewer",          desc: "Can look, can't change anything" },
    ];
    const roleLabel = key => (PM_ROLES.find(r => r.key === key) || {}).label || key;

    let pmProjectId = null;
    let pmMembers = [];      // project_members rows for the open project
    let pmStaff = [];        // active staff_users with an auth_user_id
    let pmCanEdit = false;

    function esc(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function getProfile() {
        if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
        try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); }
        catch { return null; }
    }

    function initials(name) {
        const w = String(name || "").trim().split(/\s+/).filter(Boolean);
        if (!w.length) return "?";
        return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
    }

    /* ---------- markup ---------- */

    function ensurePopup() {
        if (document.getElementById("projectMembersOverlay")) return;
        const overlay = document.createElement("div");
        overlay.className = "popup-overlay hidden";
        overlay.id = "projectMembersOverlay";
        overlay.innerHTML = `
            <div class="popup pm-popup" role="dialog" aria-modal="true" aria-labelledby="pmTitle">
                <div class="pm-header">
                    <div>
                        <p class="pm-eyebrow">Project Members</p>
                        <h2 id="pmTitle">Project</h2>
                    </div>
                    <button type="button" class="file-preview-close-btn" id="pmCloseBtn" aria-label="Close">✕</button>
                </div>

                <p class="pm-readonly-note hidden" id="pmReadOnlyNote">
                    You can view who's on this project. Only a Project Admin, IT, or Super Admin can change members.
                </p>

                <div class="pm-add hidden" id="pmAddRow">
                    <select id="pmAddStaff" aria-label="Staff member"></select>
                    <select id="pmAddRole" aria-label="Role">
                        ${PM_ROLES.map(r => `<option value="${r.key}"${r.key === "staff" ? " selected" : ""}>${r.label}</option>`).join("")}
                    </select>
                    <button type="button" class="auth-button" id="pmAddBtn">Add</button>
                </div>

                <p class="auth-message" id="pmMessage" role="status"></p>

                <div class="pm-list" id="pmList"></div>
                <p class="pm-empty hidden" id="pmEmpty">No one has been added to this project yet.</p>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.addEventListener("click", e => { if (e.target === overlay) closePopup(); });
        document.getElementById("pmCloseBtn").addEventListener("click", closePopup);
        document.getElementById("pmAddBtn").addEventListener("click", addMember);
        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && !overlay.classList.contains("hidden")) closePopup();
        });

        // One delegated listener for every row control.
        document.getElementById("pmList").addEventListener("change", e => {
            const row = e.target.closest("[data-member-id]");
            if (!row) return;
            if (e.target.matches(".pm-role-select")) updateMember(row.dataset.memberId, { role: e.target.value });
            if (e.target.matches(".pm-fin-toggle")) updateMember(row.dataset.memberId, { can_view_financials: e.target.checked });
        });
        document.getElementById("pmList").addEventListener("click", e => {
            const btn = e.target.closest(".pm-remove-btn");
            if (btn) removeMember(btn.closest("[data-member-id]").dataset.memberId);
        });
    }

    function setMessage(text, isError) {
        const el = document.getElementById("pmMessage");
        el.textContent = text || "";
        el.classList.toggle("error", !!isError);
    }

    /* ---------- open / close ---------- */

    async function openPopup(projectId, projectName) {
        ensurePopup();
        pmProjectId = projectId;
        document.getElementById("pmTitle").textContent = projectName || "Project";
        document.getElementById("pmList").innerHTML = `<p class="pm-empty">Loading…</p>`;
        document.getElementById("pmEmpty").classList.add("hidden");
        setMessage("");
        document.getElementById("projectMembersOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
        await loadData();
    }

    function closePopup() {
        const overlay = document.getElementById("projectMembersOverlay");
        if (overlay) overlay.classList.add("hidden");
        document.body.classList.remove("popup-active");
        pmProjectId = null;
    }

    /* ---------- data ---------- */

    async function loadData() {
        const client = window.supabaseClient;
        if (!client || !pmProjectId) return;

        const [membersRes, staffRes] = await Promise.all([
            client.from("project_members")
                .select("id, user_id, role, can_view_financials, created_at")
                .eq("project_id", pmProjectId),
            client.from("staff_users")
                .select("id, full_name, username, workgroup, active, auth_user_id")
                .order("full_name", { ascending: true }),
        ]);

        if (membersRes.error) {
            console.error("project_members load failed:", membersRes.error);
            document.getElementById("pmList").innerHTML = "";
            setMessage("Couldn't load project members. Has supabase-auth-rearchitecture-schema.sql been run?", true);
            return;
        }
        if (staffRes.error) console.error("staff_users load failed:", staffRes.error);

        pmMembers = membersRes.data || [];
        pmStaff = (staffRes.data || []).filter(s => s.auth_user_id && s.active !== false);

        // Edit rights: Super Admin / IT org-wide, or project_admin on this project.
        const profile = getProfile();
        const inGroup = g => window.isSupabaseUserInGroup ? window.isSupabaseUserInGroup(profile, g) : false;
        const myMembership = pmMembers.find(m => m.user_id === profile?.auth_user_id);
        pmCanEdit = inGroup("Super Admin") || inGroup("IT") || myMembership?.role === "project_admin";

        render();
    }

    function staffForAuthId(authId) {
        return pmStaff.find(s => s.auth_user_id === authId);
    }

    function render() {
        document.getElementById("pmReadOnlyNote").classList.toggle("hidden", pmCanEdit);
        document.getElementById("pmAddRow").classList.toggle("hidden", !pmCanEdit);

        // Picker: everyone not already on the project.
        const memberIds = new Set(pmMembers.map(m => m.user_id));
        const available = pmStaff.filter(s => !memberIds.has(s.auth_user_id));
        const addStaff = document.getElementById("pmAddStaff");
        addStaff.innerHTML = available.length
            ? `<option value="">Add a staff member…</option>` + available.map(s =>
                `<option value="${s.auth_user_id}">${esc(s.full_name || s.username)}${s.workgroup ? ` — ${esc(s.workgroup)}` : ""}</option>`).join("")
            : `<option value="">Everyone is already on this project</option>`;
        addStaff.disabled = !available.length;
        document.getElementById("pmAddBtn").disabled = !available.length;

        // Sort: by role order, then name.
        const order = Object.fromEntries(PM_ROLES.map((r, i) => [r.key, i]));
        const rows = pmMembers.map(m => ({ m, s: staffForAuthId(m.user_id) }))
            .sort((a, b) => (order[a.m.role] ?? 99) - (order[b.m.role] ?? 99)
                || String(a.s?.full_name || "").localeCompare(String(b.s?.full_name || "")));

        const list = document.getElementById("pmList");
        document.getElementById("pmEmpty").classList.toggle("hidden", rows.length > 0);
        list.innerHTML = rows.map(({ m, s }) => {
            const name = s ? (s.full_name || s.username) : "Former / inactive staff";
            const roleCtl = pmCanEdit
                ? `<select class="pm-role-select" aria-label="Role">${PM_ROLES.map(r =>
                    `<option value="${r.key}"${r.key === m.role ? " selected" : ""}>${r.label}</option>`).join("")}</select>`
                : `<span class="chip chip--muted">${esc(roleLabel(m.role))}</span>`;
            return `
                <div class="pm-row" data-member-id="${m.id}">
                    <span class="project-pm-avatar pm-avatar">${esc(initials(name))}</span>
                    <div class="pm-row-name">
                        <strong>${esc(name)}</strong>
                        <span>${esc(s?.workgroup || "")}</span>
                    </div>
                    ${roleCtl}
                    <label class="pm-fin" title="Can see contract value and account numbers">
                        <input type="checkbox" class="pm-fin-toggle" ${m.can_view_financials ? "checked" : ""} ${pmCanEdit ? "" : "disabled"}>
                        <span>Financials</span>
                    </label>
                    ${pmCanEdit ? `<button type="button" class="pm-remove-btn" aria-label="Remove ${esc(name)}">✕</button>` : ""}
                </div>`;
        }).join("");
    }

    async function addMember() {
        const userId = document.getElementById("pmAddStaff").value;
        const role = document.getElementById("pmAddRole").value;
        if (!userId) { setMessage("Pick a staff member to add.", true); return; }

        const btn = document.getElementById("pmAddBtn");
        btn.disabled = true;
        const { error } = await window.supabaseClient.from("project_members").insert({
            project_id: pmProjectId,
            user_id: userId,
            role,
            // Accounting gets financials by default, same as the original backfill.
            can_view_financials: role === "accounting" || role === "project_admin",
            created_by: getProfile()?.id || null,
        });
        btn.disabled = false;

        if (error) { console.error(error); setMessage("Couldn't add that person: " + error.message, true); return; }
        setMessage("");
        await loadData();
    }

    async function updateMember(memberId, changes) {
        const { error } = await window.supabaseClient.from("project_members").update(changes).eq("id", memberId);
        if (error) { console.error(error); setMessage("Couldn't save that change: " + error.message, true); }
        await loadData();
    }

    async function removeMember(memberId) {
        const m = pmMembers.find(x => x.id === memberId);
        const s = m && staffForAuthId(m.user_id);
        if (m && m.role === "project_admin" &&
            pmMembers.filter(x => x.role === "project_admin").length === 1) {
            setMessage("That's the only Project Admin. Make someone else a Project Admin first.", true);
            return;
        }
        const { error } = await window.supabaseClient.from("project_members").delete().eq("id", memberId);
        if (error) { console.error(error); setMessage("Couldn't remove " + (s?.full_name || "them") + ": " + error.message, true); return; }
        setMessage("");
        await loadData();
    }

    /* ---------- right-click on a project card ---------- */

    // Delegated on the grid, since renderProjectCards() rebuilds the cards
    // on every filter/page change.
    function wireGrid() {
        const grid = document.getElementById("projectsGrid");
        if (!grid) return;
        grid.addEventListener("contextmenu", e => {
            const card = e.target.closest(".project-card");
            if (!card || !card.dataset.projectId) return;
            e.preventDefault();
            const name = card.querySelector(".company-card-name")?.childNodes[0]?.textContent.trim();
            openPopup(card.dataset.projectId, name);
        });
    }

    window.openProjectMembers = openPopup;

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireGrid);
    else wireGrid();
})();
