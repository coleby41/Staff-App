/* ===========================================================
   PROJECT SUBMITTALS (project-submittals.html)

   Any project member can send one in; only project_admin/project_manager
   can move it through a review status — matches submittals_update_reviewers
   in SQL FILES/supabase-project-dashboard-schema.sql.

   Waits for "project-shell:ready" (project-shell.js) to know which
   project we're on, then owns everything below the header/sidebar.
=========================================================== */

(function () {
    "use strict";

    const SUBMITTALS_TABLE = "submittals";

    const STATUS_LABELS = {
        pending: "Pending",
        approved: "Approved",
        approved_as_noted: "Approved as noted",
        revise_resubmit: "Revise & resubmit",
        rejected: "Rejected"
    };

    const STATUS_CHIP = {
        pending: "chip--warning",
        approved: "chip--success",
        approved_as_noted: "chip--success",
        revise_resubmit: "chip--info",
        rejected: "chip--danger"
    };

    let currentProject = null;
    let submittals = [];
    let myProjectRole = null;
    let activeStatusFilter = "all";
    let openRowId = null;

    function escapeHtmlSub(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function setSubmittalPageMessage(text, type) {
        const el = document.getElementById("submittalPageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; return; }
        el.textContent = text;
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = "block";
        if (type === "success") setTimeout(() => { el.style.display = "none"; }, 4000);
    }

    function setPopupMessage(id, text, type) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = text || "";
        el.className = `auth-message ${type || ""}`.trim();
    }

    function canReview() {
        return myProjectRole === "project_admin" || myProjectRole === "project_manager";
    }

    /* ---------- load ---------- */

    async function loadMyProjectRole(projectId) {
        const { data, error } = await window.supabaseClient.rpc("project_role", { p_project_id: projectId });
        if (error) { console.error("Failed to resolve project role:", error); myProjectRole = null; return; }
        myProjectRole = data;
    }

    async function loadSubmittals(projectId) {
        const loadingEl = document.getElementById("submittalLoadingState");
        const emptyEl = document.getElementById("submittalEmptyState");
        if (loadingEl) loadingEl.style.display = "block";
        if (emptyEl) emptyEl.style.display = "none";

        const { data, error } = await window.supabaseClient
            .from(SUBMITTALS_TABLE)
            .select("*")
            .eq("project_id", projectId)
            .order("number", { ascending: false });

        if (loadingEl) loadingEl.style.display = "none";

        if (error) {
            console.error("Failed to load submittals:", error);
            setSubmittalPageMessage("Couldn't load submittals. If this is the first time this page has been opened, confirm SQL FILES/supabase-project-dashboard-schema.sql has been run.", "error");
            return;
        }

        submittals = data || [];
        renderSubmittalList();
    }

    /* ---------- render ---------- */

    function filteredSubmittals() {
        if (activeStatusFilter === "all") return submittals;
        return submittals.filter(s => s.status === activeStatusFilter);
    }

    function renderSubmittalList() {
        const listEl = document.getElementById("submittalList");
        const emptyEl = document.getElementById("submittalEmptyState");
        if (!listEl) return;

        const items = filteredSubmittals();

        if (items.length === 0) {
            listEl.innerHTML = "";
            if (emptyEl) emptyEl.style.display = "block";
            return;
        }
        if (emptyEl) emptyEl.style.display = "none";

        listEl.innerHTML = items.map(sub => {
            const isOpen = String(openRowId) === String(sub.id);
            return `
                <div class="record-row ${isOpen ? "is-open" : ""}" data-id="${sub.id}">
                    <div class="record-row-summary" data-action="toggle">
                        <span class="record-row-number">#${sub.number}</span>
                        <div class="record-row-title">
                            <div class="record-row-title-main">${escapeHtmlSub(sub.title)}</div>
                            <div class="record-row-title-sub">${sub.spec_section ? escapeHtmlSub(sub.spec_section) + " · " : ""}${escapeHtmlSub(sub.submitted_by_name || "Staff")}</div>
                        </div>
                        <span class="chip ${STATUS_CHIP[sub.status] || "chip--muted"}">${escapeHtmlSub(STATUS_LABELS[sub.status] || sub.status)}</span>
                    </div>
                    <div class="record-row-detail">
                        <div class="record-row-field">
                            <span class="record-row-field-label">Submitted by</span>
                            ${escapeHtmlSub(sub.submitted_by_name || "Staff")}
                        </div>
                        ${sub.due_date ? `
                        <div class="record-row-field">
                            <span class="record-row-field-label">Due</span>
                            ${escapeHtmlSub(sub.due_date)}
                        </div>` : ""}
                        ${sub.reviewed_by_name ? `
                        <div class="record-row-field">
                            <span class="record-row-field-label">Reviewed by</span>
                            ${escapeHtmlSub(sub.reviewed_by_name)}
                        </div>` : ""}
                        ${canReview() ? `
                        <div class="record-row-actions">
                            <button type="button" class="auth-button" data-action="approved" style="width:auto;padding:8px 14px;">Approve</button>
                            <button type="button" class="auth-button auth-button--secondary" data-action="approved_as_noted" style="width:auto;padding:8px 14px;">Approve as noted</button>
                            <button type="button" class="auth-button auth-button--secondary" data-action="revise_resubmit" style="width:auto;padding:8px 14px;">Revise &amp; resubmit</button>
                            <button type="button" class="auth-button auth-button--secondary" data-action="rejected" style="width:auto;padding:8px 14px;">Reject</button>
                        </div>` : ""}
                    </div>
                </div>
            `;
        }).join("");

        listEl.querySelectorAll('[data-action="toggle"]').forEach(el => {
            el.addEventListener("click", () => {
                const id = el.closest(".record-row").dataset.id;
                openRowId = String(openRowId) === String(id) ? null : id;
                renderSubmittalList();
            });
        });

        Object.keys(STATUS_LABELS).forEach(status => {
            listEl.querySelectorAll(`[data-action="${status}"]`).forEach(btn => {
                btn.addEventListener("click", (e) => { e.stopPropagation(); setSubmittalStatus(btn.closest(".record-row").dataset.id, status); });
            });
        });
    }

    async function setSubmittalStatus(id, status) {
        const profile = window.currentSupabaseProfile || null;
        const staffId = profile?.id || null;

        const { error } = await window.supabaseClient
            .from(SUBMITTALS_TABLE)
            .update({
                status,
                reviewed_by: staffId,
                reviewed_by_name: profile ? (profile.full_name || profile.username) : null,
                reviewed_at: new Date().toISOString()
            })
            .eq("id", id);

        if (error) {
            console.error("Failed to update submittal:", error);
            setSubmittalPageMessage("Couldn't update that submittal. Please try again.", "error");
            return;
        }

        setSubmittalPageMessage(`Marked ${STATUS_LABELS[status].toLowerCase()}.`, "success");
        loadSubmittals(currentProject.id);
    }

    /* ---------- new submittal popup ---------- */

    function openNewSubmittalPopup() {
        const overlay = document.getElementById("newSubmittalOverlay");
        if (!overlay) return;
        document.getElementById("newSubmittalTitle").value = "";
        document.getElementById("newSubmittalSpecSection").value = "";
        document.getElementById("newSubmittalDueDate").value = "";
        setPopupMessage("newSubmittalMessage", "");
        overlay.classList.remove("hidden");
    }

    function closeNewSubmittalPopup() {
        document.getElementById("newSubmittalOverlay").classList.add("hidden");
    }

    async function submitNewSubmittal() {
        const title = document.getElementById("newSubmittalTitle").value.trim();
        const specSection = document.getElementById("newSubmittalSpecSection").value.trim();
        const dueDate = document.getElementById("newSubmittalDueDate").value || null;

        if (!title) {
            setPopupMessage("newSubmittalMessage", "Give this submittal a title.", "error");
            return;
        }

        const { error } = await window.supabaseClient
            .from(SUBMITTALS_TABLE)
            .insert({ project_id: currentProject.id, title, spec_section: specSection || null, due_date: dueDate });

        if (error) {
            console.error("Failed to create submittal:", error);
            setPopupMessage("newSubmittalMessage", "Couldn't submit that. Please try again.", "error");
            return;
        }

        closeNewSubmittalPopup();
        setSubmittalPageMessage("Submittal sent in.", "success");
        loadSubmittals(currentProject.id);
    }

    /* ---------- wiring ---------- */

    function wireStatusTabs() {
        document.querySelectorAll("#submittalStatusTabs [data-status]").forEach(btn => {
            btn.addEventListener("click", () => {
                activeStatusFilter = btn.dataset.status;
                document.querySelectorAll("#submittalStatusTabs [data-status]").forEach(b => b.classList.toggle("active", b === btn));
                renderSubmittalList();
            });
        });
    }

    function wirePopup() {
        const newBtn = document.getElementById("newSubmittalBtn");
        if (newBtn) newBtn.addEventListener("click", openNewSubmittalPopup);

        const cancelBtn = document.getElementById("cancelNewSubmittalBtn");
        if (cancelBtn) cancelBtn.addEventListener("click", closeNewSubmittalPopup);

        const submitBtn = document.getElementById("submitNewSubmittalBtn");
        if (submitBtn) submitBtn.addEventListener("click", submitNewSubmittal);
    }

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;
        if (error) { console.error("project-shell: failed to load project", error); setSubmittalPageMessage("No project selected.", "error"); return; }
        currentProject = project;
        if (!currentProject) return;

        await loadMyProjectRole(currentProject.id);
        await loadSubmittals(currentProject.id);
    });

    document.addEventListener("DOMContentLoaded", () => {
        wireStatusTabs();
        wirePopup();
    });

})();
