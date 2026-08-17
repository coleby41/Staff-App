/* ===========================================================
   PROJECT CHANGE ORDERS (project-change-orders.html)

   project_admin/project_manager/accounting can submit one; approving or
   rejecting (and seeing the dollar amount at all) requires BOTH financial
   access on this project AND holding project_admin/accounting — matches
   change_orders_update_approvers in
   SQL FILES/supabase-project-dashboard-schema.sql. Reads go through
   change_orders_overview, which masks `amount` to null for anyone without
   financial access, same pattern as projects_overview.

   Waits for "project-shell:ready" (project-shell.js) to know which
   project we're on, then owns everything below the header/sidebar.
=========================================================== */

(function () {
    "use strict";

    const CO_WRITE_TABLE = "change_orders";
    const CO_READ_VIEW = "change_orders_overview";

    let currentProject = null;
    let changeOrders = [];
    let myProjectRole = null;
    let iHaveFinancialAccess = false;
    let activeStatusFilter = "all";
    let openRowId = null;

    function escapeHtmlCo(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function formatMoneyCo(value) {
        if (value === null || value === undefined || value === "") return "Not visible to you";
        const num = Number(value);
        if (Number.isNaN(num)) return "—";
        return num.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
    }

    function setCoPageMessage(text, type) {
        const el = document.getElementById("coPageMessage");
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

    function canApprove() {
        return iHaveFinancialAccess && (myProjectRole === "project_admin" || myProjectRole === "accounting");
    }

    function canCreate() {
        return myProjectRole === "project_admin" || myProjectRole === "project_manager" || myProjectRole === "accounting";
    }

    /* ---------- load ---------- */

    async function loadMyPermissions(projectId) {
        const [roleResult, financeResult] = await Promise.all([
            window.supabaseClient.rpc("project_role", { p_project_id: projectId }),
            window.supabaseClient.rpc("has_financial_access", { p_project_id: projectId })
        ]);
        if (roleResult.error) console.error("Failed to resolve project role:", roleResult.error);
        if (financeResult.error) console.error("Failed to resolve financial access:", financeResult.error);
        myProjectRole = roleResult.data || null;
        iHaveFinancialAccess = !!financeResult.data;

        const newBtn = document.getElementById("newChangeOrderBtn");
        if (newBtn) newBtn.style.display = canCreate() ? "inline-block" : "none";
    }

    async function loadChangeOrders(projectId) {
        const loadingEl = document.getElementById("coLoadingState");
        const emptyEl = document.getElementById("coEmptyState");
        if (loadingEl) loadingEl.style.display = "block";
        if (emptyEl) emptyEl.style.display = "none";

        const { data, error } = await window.supabaseClient
            .from(CO_READ_VIEW)
            .select("*")
            .eq("project_id", projectId)
            .order("number", { ascending: false });

        if (loadingEl) loadingEl.style.display = "none";

        if (error) {
            console.error("Failed to load change orders:", error);
            setCoPageMessage("Couldn't load change orders. If this is the first time this page has been opened, confirm SQL FILES/supabase-project-dashboard-schema.sql has been run.", "error");
            return;
        }

        changeOrders = data || [];
        renderCoList();
    }

    /* ---------- render ---------- */

    function filteredCos() {
        if (activeStatusFilter === "all") return changeOrders;
        return changeOrders.filter(c => c.status === activeStatusFilter);
    }

    function renderCoList() {
        const listEl = document.getElementById("coList");
        const emptyEl = document.getElementById("coEmptyState");
        if (!listEl) return;

        const items = filteredCos();

        if (items.length === 0) {
            listEl.innerHTML = "";
            if (emptyEl) emptyEl.style.display = "block";
            return;
        }
        if (emptyEl) emptyEl.style.display = "none";

        const statusChip = { pending: "chip--warning", approved: "chip--success", rejected: "chip--danger" };

        listEl.innerHTML = items.map(co => {
            const isOpen = String(openRowId) === String(co.id);
            return `
                <div class="record-row ${isOpen ? "is-open" : ""}" data-id="${co.id}">
                    <div class="record-row-summary" data-action="toggle">
                        <span class="record-row-number">#${co.number}</span>
                        <div class="record-row-title">
                            <div class="record-row-title-main">${escapeHtmlCo(co.title)}</div>
                            <div class="record-row-title-sub">${escapeHtmlCo(co.requested_by_name || "Staff")}</div>
                        </div>
                        <div class="record-row-meta">${escapeHtmlCo(formatMoneyCo(co.amount))}</div>
                        <span class="chip ${statusChip[co.status] || "chip--muted"}">${escapeHtmlCo(co.status)}</span>
                    </div>
                    <div class="record-row-detail">
                        ${co.description ? `
                        <div class="record-row-field">
                            <span class="record-row-field-label">Description</span>
                            ${escapeHtmlCo(co.description)}
                        </div>` : ""}
                        <div class="record-row-field">
                            <span class="record-row-field-label">Amount</span>
                            ${escapeHtmlCo(formatMoneyCo(co.amount))}
                        </div>
                        ${co.approved_by_name ? `
                        <div class="record-row-field">
                            <span class="record-row-field-label">${co.status === "rejected" ? "Rejected by" : "Approved by"}</span>
                            ${escapeHtmlCo(co.approved_by_name)}
                        </div>` : ""}
                        ${canApprove() && co.status === "pending" ? `
                        <div class="record-row-actions">
                            <button type="button" class="auth-button" data-action="approve" style="width:auto;padding:8px 16px;">Approve</button>
                            <button type="button" class="auth-button auth-button--secondary" data-action="reject" style="width:auto;padding:8px 16px;">Reject</button>
                        </div>` : ""}
                    </div>
                </div>
            `;
        }).join("");

        listEl.querySelectorAll('[data-action="toggle"]').forEach(el => {
            el.addEventListener("click", () => {
                const id = el.closest(".record-row").dataset.id;
                openRowId = String(openRowId) === String(id) ? null : id;
                renderCoList();
            });
        });

        listEl.querySelectorAll('[data-action="approve"]').forEach(btn => {
            btn.addEventListener("click", (e) => { e.stopPropagation(); setCoStatus(btn.closest(".record-row").dataset.id, "approved"); });
        });
        listEl.querySelectorAll('[data-action="reject"]').forEach(btn => {
            btn.addEventListener("click", (e) => { e.stopPropagation(); setCoStatus(btn.closest(".record-row").dataset.id, "rejected"); });
        });
    }

    async function setCoStatus(id, status) {
        const profile = window.currentSupabaseProfile || null;
        const staffId = profile?.id || null;

        const { error } = await window.supabaseClient
            .from(CO_WRITE_TABLE)
            .update({
                status,
                approved_by: staffId,
                approved_by_name: profile ? (profile.full_name || profile.username) : null,
                approved_at: new Date().toISOString()
            })
            .eq("id", id);

        if (error) {
            console.error(`Failed to ${status === "approved" ? "approve" : "reject"} change order:`, error);
            setCoPageMessage("Couldn't update that change order. Please try again.", "error");
            return;
        }

        setCoPageMessage(status === "approved" ? "Change order approved." : "Change order rejected.", "success");
        loadChangeOrders(currentProject.id);
    }

    /* ---------- new change order popup ---------- */

    function openNewCoPopup() {
        const overlay = document.getElementById("newChangeOrderOverlay");
        if (!overlay) return;
        document.getElementById("newCoTitle").value = "";
        document.getElementById("newCoDescription").value = "";
        document.getElementById("newCoAmount").value = "";
        setPopupMessage("newChangeOrderMessage", "");
        overlay.classList.remove("hidden");
    }

    function closeNewCoPopup() {
        document.getElementById("newChangeOrderOverlay").classList.add("hidden");
    }

    async function submitNewCo() {
        const title = document.getElementById("newCoTitle").value.trim();
        const description = document.getElementById("newCoDescription").value.trim();
        const amountRaw = document.getElementById("newCoAmount").value;
        const amount = amountRaw === "" ? 0 : Number(amountRaw);

        if (!title) {
            setPopupMessage("newChangeOrderMessage", "Give this change order a title.", "error");
            return;
        }
        if (Number.isNaN(amount) || amount < 0) {
            setPopupMessage("newChangeOrderMessage", "Enter a valid amount.", "error");
            return;
        }

        const { error } = await window.supabaseClient
            .from(CO_WRITE_TABLE)
            .insert({ project_id: currentProject.id, title, description, amount });

        if (error) {
            console.error("Failed to create change order:", error);
            setPopupMessage("newChangeOrderMessage", "Couldn't submit that change order. Please try again.", "error");
            return;
        }

        closeNewCoPopup();
        setCoPageMessage("Change order submitted.", "success");
        loadChangeOrders(currentProject.id);
    }

    /* ---------- wiring ---------- */

    function wireStatusTabs() {
        document.querySelectorAll("#coStatusTabs [data-status]").forEach(btn => {
            btn.addEventListener("click", () => {
                activeStatusFilter = btn.dataset.status;
                document.querySelectorAll("#coStatusTabs [data-status]").forEach(b => b.classList.toggle("active", b === btn));
                renderCoList();
            });
        });
    }

    function wirePopup() {
        const newBtn = document.getElementById("newChangeOrderBtn");
        if (newBtn) newBtn.addEventListener("click", openNewCoPopup);

        const cancelBtn = document.getElementById("cancelNewCoBtn");
        if (cancelBtn) cancelBtn.addEventListener("click", closeNewCoPopup);

        const submitBtn = document.getElementById("submitNewCoBtn");
        if (submitBtn) submitBtn.addEventListener("click", submitNewCo);
    }

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;
        if (error) { console.error("project-shell: failed to load project", error); setCoPageMessage("No project selected.", "error"); return; }
        currentProject = project;
        if (!currentProject) return;

        await loadMyPermissions(currentProject.id);
        await loadChangeOrders(currentProject.id);
    });

    document.addEventListener("DOMContentLoaded", () => {
        wireStatusTabs();
        wirePopup();
    });

})();
