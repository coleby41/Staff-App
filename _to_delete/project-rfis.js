/* ===========================================================
   PROJECT RFIs (project-rfis.html)

   Requests for Information: any project member can ask one, project
   leadership (project_admin/project_manager) or whoever it's assigned to
   can answer/close it. Full workflow — not just create+list — matching
   RLS in SQL FILES/supabase-project-dashboard-schema.sql (rfis table,
   rfis_update_answerers policy).

   Waits for "project-shell:ready" (project-shell.js) to know which
   project we're on, then owns everything below the header/sidebar.
=========================================================== */

(function () {
    "use strict";

    const RFIS_TABLE = "rfis";

    let currentProject = null;
    let rfis = [];
    let staffDirectory = [];
    let myProjectRole = null;       // via project_role() RPC — 'project_admin' | 'project_manager' | 'accounting' | 'staff' | 'viewer' | null
    let activeStatusFilter = "all";
    let openRowId = null;
    let answeringRfi = null;

    function escapeHtmlRfi(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function setRfiPageMessage(text, type) {
        const el = document.getElementById("rfiPageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; return; }
        el.textContent = text;
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = "block";
        if (type === "success") setTimeout(() => { el.style.display = "none"; }, 4000);
    }

    function getRfiStaffId() {
        const profile = window.currentSupabaseProfile
            || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
        return profile?.id || null;
    }

    function canAnswer(rfi) {
        if (myProjectRole === "project_admin" || myProjectRole === "project_manager") return true;
        return rfi.assigned_to && String(rfi.assigned_to) === String(getRfiStaffId());
    }

    /* ---------- staff directory ---------- */

    async function loadStaffDirectory() {
        if (!window.supabaseClient) return;
        const { data, error } = await window.supabaseClient
            .from("staff_users_directory")
            .select("id, full_name, active")
            .eq("active", true)
            .order("full_name", { ascending: true });
        if (error) { console.error("Failed to load staff directory:", error); return; }
        staffDirectory = data || [];
    }

    function assigneeOptionsHtml(selectedId) {
        const options = [`<option value="">Unassigned</option>`];
        staffDirectory.forEach(person => {
            const selected = String(person.id) === String(selectedId) ? "selected" : "";
            options.push(`<option value="${person.id}" ${selected}>${escapeHtmlRfi(person.full_name || "Staff")}</option>`);
        });
        return options.join("");
    }

    /* ---------- load ---------- */

    async function loadMyProjectRole(projectId) {
        const { data, error } = await window.supabaseClient.rpc("project_role", { p_project_id: projectId });
        if (error) { console.error("Failed to resolve project role:", error); myProjectRole = null; return; }
        myProjectRole = data;
    }

    async function loadRfis(projectId) {
        const loadingEl = document.getElementById("rfiLoadingState");
        const emptyEl = document.getElementById("rfiEmptyState");
        if (loadingEl) loadingEl.style.display = "block";
        if (emptyEl) emptyEl.style.display = "none";

        const { data, error } = await window.supabaseClient
            .from(RFIS_TABLE)
            .select("*")
            .eq("project_id", projectId)
            .order("number", { ascending: false });

        if (loadingEl) loadingEl.style.display = "none";

        if (error) {
            console.error("Failed to load RFIs:", error);
            setRfiPageMessage("Couldn't load RFIs. If this is the first time this page has been opened, confirm SQL FILES/supabase-project-dashboard-schema.sql has been run.", "error");
            return;
        }

        rfis = data || [];
        renderRfiList();
    }

    /* ---------- render ---------- */

    function filteredRfis() {
        if (activeStatusFilter === "all") return rfis;
        return rfis.filter(r => r.status === activeStatusFilter);
    }

    function renderRfiList() {
        const listEl = document.getElementById("rfiList");
        const emptyEl = document.getElementById("rfiEmptyState");
        if (!listEl) return;

        const items = filteredRfis();

        if (items.length === 0) {
            listEl.innerHTML = "";
            if (emptyEl) emptyEl.style.display = "block";
            return;
        }
        if (emptyEl) emptyEl.style.display = "none";

        const statusChip = { open: "chip--info", answered: "chip--success", closed: "chip--muted" };

        listEl.innerHTML = items.map(rfi => {
            const isOpen = String(openRowId) === String(rfi.id);
            return `
                <div class="record-row ${isOpen ? "is-open" : ""}" data-id="${rfi.id}">
                    <div class="record-row-summary" data-action="toggle">
                        <span class="record-row-number">#${rfi.number}</span>
                        <div class="record-row-title">
                            <div class="record-row-title-main">${escapeHtmlRfi(rfi.subject)}</div>
                            <div class="record-row-title-sub">${escapeHtmlRfi(rfi.assigned_to_name || "Unassigned")}${rfi.due_date ? ` · Due ${escapeHtmlRfi(rfi.due_date)}` : ""}</div>
                        </div>
                        <span class="chip ${statusChip[rfi.status] || "chip--muted"}">${escapeHtmlRfi(rfi.status)}</span>
                    </div>
                    <div class="record-row-detail">
                        <div class="record-row-field">
                            <span class="record-row-field-label">Question</span>
                            ${escapeHtmlRfi(rfi.question)}
                        </div>
                        ${rfi.answer ? `
                        <div class="record-row-field">
                            <span class="record-row-field-label">Answer</span>
                            ${escapeHtmlRfi(rfi.answer)}
                        </div>` : ""}
                        <div class="record-row-field">
                            <span class="record-row-field-label">Asked by</span>
                            ${escapeHtmlRfi(rfi.asked_by_name || "Staff")}
                        </div>
                        ${canAnswer(rfi) && rfi.status !== "closed" ? `
                        <div class="record-row-actions">
                            <button type="button" class="auth-button auth-button--secondary" data-action="answer" style="width:auto;padding:8px 16px;">
                                ${rfi.status === "answered" ? "Edit answer" : "Answer"}
                            </button>
                        </div>` : ""}
                    </div>
                </div>
            `;
        }).join("");

        listEl.querySelectorAll('[data-action="toggle"]').forEach(el => {
            el.addEventListener("click", () => {
                const id = el.closest(".record-row").dataset.id;
                openRowId = String(openRowId) === String(id) ? null : id;
                renderRfiList();
            });
        });

        listEl.querySelectorAll('[data-action="answer"]').forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const id = btn.closest(".record-row").dataset.id;
                openAnswerPopup(rfis.find(r => String(r.id) === String(id)));
            });
        });
    }

    /* ---------- new RFI popup ---------- */

    function openNewRfiPopup() {
        const overlay = document.getElementById("newRfiOverlay");
        if (!overlay) return;
        document.getElementById("newRfiSubject").value = "";
        document.getElementById("newRfiQuestion").value = "";
        document.getElementById("newRfiAssignee").innerHTML = assigneeOptionsHtml(null);
        document.getElementById("newRfiDueDate").value = "";
        setPopupMessage("newRfiMessage", "");
        overlay.classList.remove("hidden");
    }

    function closeNewRfiPopup() {
        document.getElementById("newRfiOverlay").classList.add("hidden");
    }

    async function submitNewRfi() {
        const subject = document.getElementById("newRfiSubject").value.trim();
        const question = document.getElementById("newRfiQuestion").value.trim();
        const assignedTo = document.getElementById("newRfiAssignee").value || null;
        const dueDate = document.getElementById("newRfiDueDate").value || null;

        if (!subject || !question) {
            setPopupMessage("newRfiMessage", "Subject and question are both required.", "error");
            return;
        }

        const assignee = staffDirectory.find(p => String(p.id) === String(assignedTo));

        const { error } = await window.supabaseClient
            .from(RFIS_TABLE)
            .insert({
                project_id: currentProject.id,
                subject,
                question,
                assigned_to: assignedTo,
                assigned_to_name: assignee ? assignee.full_name : null,
                due_date: dueDate
            });

        if (error) {
            console.error("Failed to create RFI:", error);
            setPopupMessage("newRfiMessage", "Couldn't submit that RFI. Please try again.", "error");
            return;
        }

        closeNewRfiPopup();
        setRfiPageMessage("RFI submitted.", "success");
        loadRfis(currentProject.id);
    }

    /* ---------- answer / close popup ---------- */

    function openAnswerPopup(rfi) {
        if (!rfi) return;
        answeringRfi = rfi;
        document.getElementById("answerRfiTitle").textContent = `Answer RFI #${rfi.number}`;
        document.getElementById("answerRfiText").value = rfi.answer || "";
        setPopupMessage("answerRfiMessage", "");
        document.getElementById("answerRfiOverlay").classList.remove("hidden");
    }

    function closeAnswerPopup() {
        answeringRfi = null;
        document.getElementById("answerRfiOverlay").classList.add("hidden");
    }

    async function saveRfiAnswer(alsoClose) {
        if (!answeringRfi) return;
        const answer = document.getElementById("answerRfiText").value.trim();
        if (!answer) {
            setPopupMessage("answerRfiMessage", "Type an answer first.", "error");
            return;
        }

        const profile = window.currentSupabaseProfile || null;
        const { error } = await window.supabaseClient
            .from(RFIS_TABLE)
            .update({
                answer,
                status: alsoClose ? "closed" : "answered",
                answered_by: getRfiStaffId(),
                answered_by_name: profile ? (profile.full_name || profile.username) : null,
                answered_at: new Date().toISOString()
            })
            .eq("id", answeringRfi.id);

        if (error) {
            console.error("Failed to save RFI answer:", error);
            setPopupMessage("answerRfiMessage", "Couldn't save that answer. Please try again.", "error");
            return;
        }

        closeAnswerPopup();
        setRfiPageMessage(alsoClose ? "RFI closed." : "Answer saved.", "success");
        loadRfis(currentProject.id);
    }

    function setPopupMessage(id, text, type) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = text || "";
        el.className = `auth-message ${type || ""}`.trim();
    }

    /* ---------- wiring ---------- */

    function wireStatusTabs() {
        document.querySelectorAll("#rfiStatusTabs [data-status]").forEach(btn => {
            btn.addEventListener("click", () => {
                activeStatusFilter = btn.dataset.status;
                document.querySelectorAll("#rfiStatusTabs [data-status]").forEach(b => b.classList.toggle("active", b === btn));
                renderRfiList();
            });
        });
    }

    function wirePopups() {
        const newBtn = document.getElementById("newRfiBtn");
        if (newBtn) newBtn.addEventListener("click", openNewRfiPopup);

        const cancelNew = document.getElementById("cancelNewRfiBtn");
        if (cancelNew) cancelNew.addEventListener("click", closeNewRfiPopup);

        const submitNew = document.getElementById("submitNewRfiBtn");
        if (submitNew) submitNew.addEventListener("click", submitNewRfi);

        const cancelAnswer = document.getElementById("cancelAnswerRfiBtn");
        if (cancelAnswer) cancelAnswer.addEventListener("click", closeAnswerPopup);

        const saveAnswer = document.getElementById("saveAnswerRfiBtn");
        if (saveAnswer) saveAnswer.addEventListener("click", () => saveRfiAnswer(false));

        const closeRfi = document.getElementById("closeRfiBtn");
        if (closeRfi) closeRfi.addEventListener("click", () => saveRfiAnswer(true));
    }

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;
        if (error) { console.error("project-shell: failed to load project", error); setRfiPageMessage("No project selected.", "error"); return; }
        currentProject = project;
        if (!currentProject) return;

        await Promise.all([loadStaffDirectory(), loadMyProjectRole(currentProject.id)]);
        await loadRfis(currentProject.id);
    });

    document.addEventListener("DOMContentLoaded", () => {
        wireStatusTabs();
        wirePopups();
    });

})();
