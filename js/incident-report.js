/* ===========================================================
   INCIDENT REPORT — submission form (pages/incident-report.html)

   Submitting is open to any signed-in staff member for now (per Coleby:
   "right now just anyone, we'll work on this later" — narrowing this to a
   workgroup is a follow-up, not something this file needs to guess at).

   The approver is set ONE TIME, globally, by Super Admin/IT — a "Set
   Approver" button above the form, visible only to them, that reads/writes
   the single-row incident_report_settings table (Coleby: "I want to set it
   one time and be done with it"). Every report submitted after that is
   routed automatically to whoever is set there (stamped by the
   set_incident_report_defaults() trigger — see
   sql/supabase-incident-reports-setup.sql — not by this file); if nobody
   has set one yet, submission is blocked with a clear message.

   On submit: inserts a row into incident_reports (already
   `pending_approval`, already assigned, by the time it comes back),
   uploads any attached PDFs/photos to the private
   incident-report-attachments bucket, and notifies the assigned approver
   that a new report is waiting on them — see js/account-activity.js for
   everything that happens after that (approving/rejecting, the final
   merged PDF + filing).
=========================================================== */

(function () {
    "use strict";

    const INCIDENT_REPORTS_TABLE = "incident_reports";
    const SETTINGS_TABLE = "incident_report_settings";
    const ATTACHMENTS_BUCKET = "incident-report-attachments";
    const MAX_ATTACHMENT_MB = 15;

    let allProjects = [];
    let allStaff = [];
    // [{ id, file, name, kind }] for a new file picked this session, or
    // [{ id, existing: true, path, name, kind }] for one already on the
    // report being edited (see loadReportForEdit()) — rendered/removed the
    // same way either way; only ones missing `existing` get uploaded.
    let pendingAttachments = [];
    let attachmentIdSeq = 0;
    let isAdmin = false;
    let currentApproverSetting = null; // { default_approver_id, default_approver_name }

    // Set once loadReportForEdit() finds a valid rejected report to edit —
    // switches handleSubmit() from inserting a new report to updating this
    // one in place and resubmitting it (see pages/account-activity.html's
    // "Edit & Resubmit" button, which links here with ?edit=<id>).
    let editingReportId = null;
    let editingAssignedApproverId = null;

    function irEscapeHtml(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    /* ---------- Reason for Report rich text editor ----------
       A lightweight contenteditable + document.execCommand toolbar --
       no editor library pulled in, matching this app's no-build-step/
       no-framework approach everywhere else. reason_for_report now stores
       HTML (was plain text before); js/incident-report-pdf.js converts it
       back into formatted pdfmake content when building the filed PDF. */

    function irReasonToEditableHtml(value) {
        if (!value) return "";
        // A report saved before this editor existed has a plain string in
        // reason_for_report -- wrap it as a paragraph (escaping + carrying
        // over line breaks) so it opens back up as normal editable text
        // instead of literal "<" / ">" characters. Anything that already
        // looks like HTML (saved by this editor) is used as-is.
        if (/<[a-z][\s\S]*>/i.test(value)) return value;
        return `<p>${irEscapeHtml(value).replace(/\n/g, "<br>")}</p>`;
    }

    function irReasonPlainText(html) {
        if (!html) return "";
        const d = document.createElement("div");
        d.innerHTML = html;
        return (d.textContent || "").trim();
    }

    function updateReasonPlaceholderState() {
        const body = document.getElementById("irReasonBody");
        if (!body) return;
        body.classList.toggle("ir-richtext-body--empty", irReasonPlainText(body.innerHTML) === "");
    }

    function syncReasonToolbarState() {
        const toolbar = document.getElementById("irReasonToolbar");
        if (!toolbar) return;
        ["bold", "italic", "underline"].forEach(cmd => {
            const btn = toolbar.querySelector(`[data-ir-cmd="${cmd}"]`);
            if (!btn) return;
            let active = false;
            try { active = document.queryCommandState(cmd); } catch (err) { active = false; }
            btn.classList.toggle("is-active", active);
        });
        const select = document.getElementById("irReasonBlockSelect");
        if (select) {
            let blockTag = "p";
            try {
                const value = (document.queryCommandValue("formatBlock") || "").toLowerCase();
                if (value === "h1" || value === "h2" || value === "h3") blockTag = value;
            } catch (err) { /* ignore -- leave select on Paragraph */ }
            select.value = blockTag;
        }
    }

    function initReasonEditor() {
        const body = document.getElementById("irReasonBody");
        const toolbar = document.getElementById("irReasonToolbar");
        const select = document.getElementById("irReasonBlockSelect");
        if (!body || !toolbar) return;

        // Without this, some browsers wrap formatting in inline `style`
        // attributes (styleWithCSS) instead of semantic <b>/<i>/<u> tags --
        // keeping it off means both this editor and the PDF converter in
        // js/incident-report-pdf.js only ever have to look for one shape.
        try { document.execCommand("styleWithCSS", false, false); } catch (err) { /* older Safari ignores this fine */ }

        updateReasonPlaceholderState();

        toolbar.querySelectorAll("[data-ir-cmd]").forEach(btn => {
            // mousedown + preventDefault keeps the editor's current
            // selection alive through the click -- a plain click would
            // blur the contenteditable first and drop whatever was
            // selected before the command ever ran.
            btn.addEventListener("mousedown", (event) => event.preventDefault());
            btn.addEventListener("click", () => {
                const cmd = btn.getAttribute("data-ir-cmd");
                body.focus();
                if (cmd === "createLink") {
                    const url = window.prompt("Link URL:", "https://");
                    if (!url) return;
                    document.execCommand("createLink", false, url);
                } else if (cmd === "blockquote") {
                    document.execCommand("formatBlock", false, "blockquote");
                } else {
                    document.execCommand(cmd, false, null);
                }
                updateReasonPlaceholderState();
                syncReasonToolbarState();
            });
        });

        if (select) {
            select.addEventListener("mousedown", (event) => event.stopPropagation());
            select.addEventListener("change", () => {
                body.focus();
                document.execCommand("formatBlock", false, select.value);
                syncReasonToolbarState();
            });
        }

        body.addEventListener("input", updateReasonPlaceholderState);
        body.addEventListener("keyup", syncReasonToolbarState);
        body.addEventListener("mouseup", syncReasonToolbarState);
        body.addEventListener("focus", syncReasonToolbarState);
    }

    function getIrStaffProfile() {
        return window.currentSupabaseProfile
            || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    }
    function getIrStaffId() {
        const profile = getIrStaffProfile();
        return profile?.id || profile?.uid || null;
    }
    function getIrStaffName() {
        const profile = getIrStaffProfile();
        return (profile && (profile.full_name || profile.username)) || "Staff";
    }

    /* ---------- date ---------- */

    function todayDateParts() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, "0");
        const d = String(now.getDate()).padStart(2, "0");
        return { iso: `${y}-${m}-${d}`, display: `${m}/${d}/${y}` };
    }

    function renderTodayDate() {
        const el = document.getElementById("irDateDisplay");
        if (el) el.textContent = todayDateParts().display;
    }

    /* ---------- projects dropdown ---------- */

    async function loadIrProjects() {
        const select = document.getElementById("irProjectSelect");
        if (!select || !window.supabaseClient) return;

        const { data, error } = await window.supabaseClient
            .from("projects")
            .select("id, name, project_code, is_active")
            .order("name", { ascending: true });

        if (error) {
            console.error("Failed to load projects:", error);
            return;
        }

        allProjects = (data || []).filter(p => p.is_active !== false);

        select.innerHTML = `<option value="">Select a project…</option>` +
            allProjects.map(p => `<option value="${irEscapeHtml(p.id)}">${irEscapeHtml(p.name || "Untitled project")}</option>`).join("");
    }

    /* ---------- currency input ---------- */

    function formatCurrencyDisplay(numberValue) {
        if (Number.isNaN(numberValue)) return "";
        return numberValue.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function parseCurrencyInput(raw) {
        const cleaned = String(raw || "").replace(/[^0-9.]/g, "");
        if (!cleaned) return null;
        const num = Number(cleaned);
        return Number.isNaN(num) ? null : num;
    }

    function initCurrencyInput() {
        const input = document.getElementById("irPriceInput");
        if (!input) return;

        input.addEventListener("focus", () => {
            const num = parseCurrencyInput(input.value);
            input.value = num === null ? "" : String(num);
        });

        input.addEventListener("blur", () => {
            const num = parseCurrencyInput(input.value);
            input.value = num === null ? "" : formatCurrencyDisplay(num);
        });
    }

    /* ---------- attachments ---------- */

    function guessKind(file) {
        if (file.type === "application/pdf") return "pdf";
        if (file.type.startsWith("image/")) return "image";
        return "pdf";
    }

    function renderAttachmentsList() {
        const list = document.getElementById("irAttachmentsList");
        if (!list) return;
        list.innerHTML = "";

        // Attachments flagged hidden (via the "Hide from card" toggle on
        // Account Activity's See more popup — see toggleAttachmentHidden()
        // in js/account-activity.js) stay out of this list too, so
        // resubmitting a report doesn't put the file back in front of you
        // just because it's off the card. They're still kept internally in
        // pendingAttachments and carried through on resubmit (see
        // handleSubmit()'s existingKept) — "don't display it," not delete.
        pendingAttachments.filter(att => !att.hidden).forEach(att => {
            const row = document.createElement("div");
            row.className = "ir-attachment-row";
            row.innerHTML = `
                <span class="ir-attachment-icon ir-attachment-icon--${att.kind}" aria-hidden="true"></span>
                <span class="ir-attachment-name">${irEscapeHtml(att.name)}</span>
                <button type="button" class="form-field-remove-btn" data-id="${att.id}" aria-label="Remove ${irEscapeHtml(att.name)}">✕</button>
            `;
            row.querySelector("button").addEventListener("click", () => {
                pendingAttachments = pendingAttachments.filter(a => a.id !== att.id);
                renderAttachmentsList();
            });
            list.appendChild(row);
        });
    }

    function initAttachmentPicker() {
        const input = document.getElementById("irAttachmentsInput");
        if (!input) return;

        input.addEventListener("change", () => {
            const messageEl = document.getElementById("irFormMessage");
            Array.from(input.files || []).forEach(file => {
                if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
                    if (messageEl) { messageEl.textContent = `"${file.name}" is larger than ${MAX_ATTACHMENT_MB}MB and wasn't added.`; messageEl.className = "auth-message error"; }
                    return;
                }
                pendingAttachments.push({ id: `att-${++attachmentIdSeq}`, file, name: file.name, kind: guessKind(file) });
            });
            input.value = "";
            renderAttachmentsList();
        });
    }

    /* ---------- default approver setting (Super Admin / IT only) ---------- */

    async function loadIrStaff() {
        const { data, error } = await window.supabaseClient
            .from("staff_users")
            .select("id, full_name, workgroup, active")
            .order("full_name", { ascending: true });
        if (error) { console.warn("Couldn't load staff:", error); return; }
        allStaff = data || [];
    }

    async function loadApproverSetting() {
        const { data, error } = await window.supabaseClient
            .from(SETTINGS_TABLE)
            .select("default_approver_id, default_approver_name")
            .eq("id", true)
            .maybeSingle();
        if (error) { console.warn("Couldn't load approver setting:", error); return; }
        currentApproverSetting = data || null;
    }

    function updateApproverUi() {
        const card = document.getElementById("irApproverCard");
        const valueEl = document.getElementById("irApproverValue");
        const banner = document.getElementById("irNoApproverBanner");
        const submitBtn = document.getElementById("irSubmitBtn");
        const hasApprover = !!(currentApproverSetting && currentApproverSetting.default_approver_id);

        if (card) card.classList.toggle("hidden", !isAdmin);
        if (valueEl) {
            valueEl.textContent = hasApprover ? currentApproverSetting.default_approver_name || "Staff" : "Not set";
        }
        const setBtn = document.getElementById("irSetApproverBtn");
        if (setBtn) setBtn.textContent = hasApprover ? "Change Approver" : "Set Approver";

        if (banner) banner.classList.toggle("hidden", hasApprover || isAdmin);
        if (submitBtn) submitBtn.disabled = !hasApprover;
    }

    function openSetApproverPopup() {
        const select = document.getElementById("irSetApproverSelect");
        if (!select) return;
        const active = allStaff.filter(s => s.active !== false);
        select.innerHTML = active.map(s => `<option value="${irEscapeHtml(s.id)}">${irEscapeHtml(s.full_name || "Staff")}</option>`).join("");
        if (currentApproverSetting && currentApproverSetting.default_approver_id) {
            select.value = currentApproverSetting.default_approver_id;
        }

        const messageEl = document.getElementById("irSetApproverMessage");
        if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

        document.getElementById("irSetApproverOverlay")?.classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeSetApproverPopup() {
        document.getElementById("irSetApproverOverlay")?.classList.add("hidden");
        document.body.classList.remove("popup-active");
    }

    async function saveApproverSetting() {
        const select = document.getElementById("irSetApproverSelect");
        const messageEl = document.getElementById("irSetApproverMessage");
        const saveBtn = document.getElementById("irSaveSetApproverBtn");
        const approverId = select?.value;
        if (!approverId) return;

        if (saveBtn) saveBtn.disabled = true;
        if (messageEl) { messageEl.textContent = "Saving…"; messageEl.className = "auth-message"; }

        try {
            const { data, error } = await window.supabaseClient
                .from(SETTINGS_TABLE)
                .update({ default_approver_id: approverId })
                .eq("id", true)
                .select("default_approver_id, default_approver_name")
                .single();
            if (error) throw error;

            currentApproverSetting = data;
            updateApproverUi();
            closeSetApproverPopup();
        } catch (error) {
            console.error("Failed to save default approver:", error);
            if (messageEl) { messageEl.textContent = "Something went wrong saving this. Please try again."; messageEl.className = "auth-message error"; }
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    function initApproverSettingUi() {
        document.getElementById("irSetApproverBtn")?.addEventListener("click", openSetApproverPopup);
        document.getElementById("irCancelSetApproverBtn")?.addEventListener("click", closeSetApproverPopup);
        document.getElementById("irSaveSetApproverBtn")?.addEventListener("click", saveApproverSetting);
    }

    /* ---------- notify the assigned approver that a report is waiting ---------- */

    async function notifyApproverNeedsReview(approverId, projectName) {
        if (!approverId) return;
        try {
            await window.supabaseClient.from("notifications").insert({
                user_id: approverId,
                title: "Incident Report needs your approval",
                message: `${getIrStaffName()} submitted an Incident Report for ${projectName || "a project"}. Review it on your Account Activity page.`,
                type: "incident_report_assigned",
                link_url: "/pages/account-activity.html",
                link_label: "Review it here",
            });
        } catch (err) {
            console.warn("Couldn't send needs-review notification:", err);
        }
    }

    /* ---------- edit & resubmit a rejected report ---------- */

    // pages/account-activity.html's "Edit & Resubmit" button (only shown on
    // a rejected report, to its original submitter) links here with
    // ?edit=<id> — Coleby: "the person needs to edit that form and not make
    // a new form." Pre-fills every field from the existing row and switches
    // handleSubmit() into update-in-place mode.
    async function loadReportForEdit(reportId) {
        const messageEl = document.getElementById("irFormMessage");
        const staffId = getIrStaffId();

        const { data: report, error } = await window.supabaseClient
            .from(INCIDENT_REPORTS_TABLE)
            .select("*")
            .eq("id", reportId)
            .maybeSingle();

        if (error || !report) {
            console.error("Failed to load report for edit:", error);
            if (messageEl) { messageEl.textContent = "Couldn't load that report to edit. Please try again from Account Activity."; messageEl.className = "auth-message error"; }
            return;
        }
        if (report.status !== "rejected" || String(report.submitted_by) !== String(staffId)) {
            if (messageEl) { messageEl.textContent = "That report isn't available to edit right now."; messageEl.className = "auth-message error"; }
            return;
        }

        editingReportId = report.id;
        editingAssignedApproverId = report.assigned_approver_id;

        const projectSelect = document.getElementById("irProjectSelect");
        if (projectSelect) projectSelect.value = report.project_id || "";
        const priceInput = document.getElementById("irPriceInput");
        if (priceInput) priceInput.value = report.price === null || report.price === undefined ? "" : formatCurrencyDisplay(Number(report.price));
        const buildingsInput = document.getElementById("irBuildingsInput");
        if (buildingsInput) buildingsInput.value = report.buildings || "";
        const unitNumbersInput = document.getElementById("irUnitNumbersInput");
        if (unitNumbersInput) unitNumbersInput.value = report.unit_numbers || "";
        const personInput = document.getElementById("irPersonInput");
        if (personInput) personInput.value = report.person_making_report || "";
        const reasonBody = document.getElementById("irReasonBody");
        if (reasonBody) {
            reasonBody.innerHTML = irReasonToEditableHtml(report.reason_for_report);
            updateReasonPlaceholderState();
        }
        const whoCausedInput = document.getElementById("irWhoCausedInput");
        if (whoCausedInput) whoCausedInput.value = report.who_caused_issue || "";

        pendingAttachments = (Array.isArray(report.attachments) ? report.attachments : []).map(att => ({
            id: `att-${++attachmentIdSeq}`,
            existing: true,
            path: att.path,
            name: att.name,
            kind: att.kind || "pdf",
            hidden: !!att.hidden,
        }));
        renderAttachmentsList();

        const banner = document.getElementById("irEditBanner");
        if (banner) {
            banner.textContent = report.decision_reason
                ? `You're fixing a rejected report and resubmitting it. It was rejected: ${report.decision_reason}`
                : "You're fixing a rejected report and resubmitting it.";
            banner.classList.remove("hidden");
        }
        const submitBtn = document.getElementById("irSubmitBtn");
        if (submitBtn) submitBtn.textContent = "Resubmit Incident Report";
    }

    /* ---------- submit ---------- */

    function setSubmitting(isSubmitting) {
        const btn = document.getElementById("irSubmitBtn");
        if (btn) { btn.disabled = isSubmitting; btn.textContent = isSubmitting ? "Submitting…" : (editingReportId ? "Resubmit Incident Report" : "Submit Incident Report"); }
    }

    // Uploads only the NEW files in pendingAttachments (skips ones already
    // on the report being edited — those just get carried over by path, see
    // handleSubmit()) and returns their metadata.
    async function uploadPendingAttachments(reportId) {
        const toUpload = pendingAttachments.filter(att => !att.existing);
        const metadata = [];
        for (let i = 0; i < toUpload.length; i++) {
            const att = toUpload[i];
            const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, "_");
            const path = `${reportId}/attachments/${Date.now()}-${i}-${safeName}`;
            const { error } = await window.supabaseClient.storage
                .from(ATTACHMENTS_BUCKET)
                .upload(path, att.file, { cacheControl: "3600", upsert: true, contentType: att.file.type || undefined });
            if (error) throw new Error(`Couldn't upload "${att.name}": ${error.message}`);
            metadata.push({ name: att.name, path, kind: att.kind });
        }
        return metadata;
    }

    async function handleSubmit(event) {
        event.preventDefault();
        const messageEl = document.getElementById("irFormMessage");
        const setMessage = (text, cls) => { if (messageEl) { messageEl.textContent = text; messageEl.className = `auth-message ${cls || ""}`.trim(); } };

        const projectId = document.getElementById("irProjectSelect").value;
        const priceRaw = document.getElementById("irPriceInput").value;
        const buildings = document.getElementById("irBuildingsInput").value.trim();
        const unitNumbers = document.getElementById("irUnitNumbersInput").value.trim();
        const person = document.getElementById("irPersonInput").value.trim();
        const reasonBody = document.getElementById("irReasonBody");
        const reason = reasonBody ? reasonBody.innerHTML.trim() : "";
        const whoCaused = document.getElementById("irWhoCausedInput").value.trim();

        if (!projectId) { setMessage("Please select a project.", "error"); return; }
        if (parseCurrencyInput(priceRaw) === null) { setMessage("Please enter a price.", "error"); return; }
        if (!buildings) { setMessage("Please enter the building(s).", "error"); return; }
        if (!unitNumbers) { setMessage("Please enter the unit number(s).", "error"); return; }
        if (!person) { setMessage("Please enter who's making this report.", "error"); return; }
        if (!irReasonPlainText(reason)) { setMessage("Please enter a reason for this report.", "error"); return; }
        if (!whoCaused) { setMessage("Please enter who caused the issue.", "error"); return; }
        if (!pendingAttachments.length) { setMessage("Please attach at least one supporting PDF or photo.", "error"); return; }

        setSubmitting(true);
        setMessage("Submitting…", "");

        try {
            const staffId = getIrStaffId();
            const staffName = getIrStaffName();

            if (editingReportId) {
                // Resubmitting a rejected report: update the SAME row (Coleby:
                // "the person needs to edit that form and not make a new
                // form") — the enforce_incident_report_transitions() trigger
                // flips it back to pending_approval, clears the old decision,
                // and logs the "resubmitted" timeline event.
                // Carries the `hidden` flag through on resubmit -- without
                // this, resubmitting silently un-hid any attachment
                // previously hidden from the card (see renderAttachmentsList()
                // above and toggleAttachmentHidden() in account-activity.js).
                const existingKept = pendingAttachments.filter(a => a.existing).map(a => ({ name: a.name, path: a.path, kind: a.kind, hidden: !!a.hidden }));
                const newlyUploaded = await uploadPendingAttachments(editingReportId);
                const mergedAttachments = existingKept.concat(newlyUploaded);

                const { error: updateError } = await window.supabaseClient
                    .from(INCIDENT_REPORTS_TABLE)
                    .update({
                        project_id: projectId,
                        price: parseCurrencyInput(priceRaw),
                        buildings: buildings || null,
                        unit_numbers: unitNumbers || null,
                        person_making_report: person,
                        reason_for_report: reason,
                        who_caused_issue: whoCaused || null,
                        attachments: mergedAttachments,
                        status: "pending_approval",
                    })
                    .eq("id", editingReportId);
                if (updateError) throw updateError;

                const project = allProjects.find(p => String(p.id) === String(projectId));
                await notifyApproverNeedsReview(editingAssignedApproverId, project?.name);

                setMessage("Incident report resubmitted. Redirecting to your Account Activity page…", "success");
                setTimeout(() => { window.location.href = "/pages/account-activity.html"; }, 1200);
                return;
            }

            const { iso: reportDate } = todayDateParts();

            const { data: inserted, error: insertError } = await window.supabaseClient
                .from(INCIDENT_REPORTS_TABLE)
                .insert({
                    project_id: projectId,
                    report_date: reportDate,
                    price: parseCurrencyInput(priceRaw),
                    buildings: buildings || null,
                    unit_numbers: unitNumbers || null,
                    person_making_report: person,
                    reason_for_report: reason,
                    who_caused_issue: whoCaused || null,
                    submitted_by: staffId,
                    submitted_by_name: staffName,
                })
                .select()
                .single();

            if (insertError) throw insertError;

            if (pendingAttachments.length) {
                const attachmentMetadata = await uploadPendingAttachments(inserted.id);
                const { error: updateError } = await window.supabaseClient
                    .from(INCIDENT_REPORTS_TABLE)
                    .update({ attachments: attachmentMetadata })
                    .eq("id", inserted.id);
                if (updateError) throw updateError;
            }

            const project = allProjects.find(p => String(p.id) === String(projectId));
            await notifyApproverNeedsReview(inserted.assigned_approver_id, project?.name);

            setMessage("Incident report submitted. Track its status on your Account Activity page.", "success");
            document.getElementById("incidentReportForm").reset();
            // A native form reset doesn't touch a contenteditable div (it's
            // not a form-associated control), so the rich text editor has
            // to be cleared by hand or the old reason would stick around
            // for the next report.
            if (reasonBody) { reasonBody.innerHTML = ""; updateReasonPlaceholderState(); }
            pendingAttachments = [];
            renderAttachmentsList();
            renderTodayDate();

        } catch (error) {
            console.error("Failed to submit incident report:", error);
            const dbMessage = error?.message || "";
            setMessage(
                dbMessage.includes("No default approver is set up")
                    ? dbMessage
                    : "Something went wrong submitting this. Please try again.",
                "error"
            );
        } finally {
            setSubmitting(false);
        }
    }

    /* ---------- init ---------- */

    async function initIncidentReportPage(attempts) {
        attempts = attempts || 0;
        const clientReady = !!window.supabaseClient;
        const profile = getIrStaffProfile();

        if ((!clientReady || !profile) && attempts < 25) {
            setTimeout(() => initIncidentReportPage(attempts + 1), 200);
            return;
        }
        if (!clientReady) return;

        isAdmin = !!(window.isSupabaseUserInGroup && profile &&
            (window.isSupabaseUserInGroup(profile, "IT") || window.isSupabaseUserInGroup(profile, "Super Admin")));

        renderTodayDate();
        initCurrencyInput();
        initAttachmentPicker();
        initReasonEditor();
        initApproverSettingUi();

        await Promise.all([loadIrProjects(), loadIrStaff(), loadApproverSetting()]);
        updateApproverUi();

        const editId = new URLSearchParams(window.location.search).get("edit");
        if (editId) await loadReportForEdit(editId);

        const form = document.getElementById("incidentReportForm");
        if (form) form.addEventListener("submit", handleSubmit);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => initIncidentReportPage());
    } else {
        initIncidentReportPage();
    }
})();
