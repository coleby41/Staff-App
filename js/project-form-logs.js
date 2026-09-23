/* ===========================================================
   FORM LOGS (project-form-logs.html)

   Read-only per-project log of every VPO, Back Charge, and approved
   Incident Report — three tables (ID | Vendor | Date | Comment | Amount).
   Clicking an ID opens that row's filed document (a signed URL into the
   project-documents bucket), when one exists; rows that haven't been
   filed yet (e.g. a BC/VPO whose template-fill step failed — see the
   graceful-degradation handling in confirmBc()/confirmVpo() in
   js/account-activity.js) show a plain, unlinked "not filed yet" id
   instead of a dead link.

   Waits for the "project-shell:ready" event (project-shell.js) to know
   which project we're on, then owns everything below the header/sidebar.

   Tables read: vpos, back_charges, incident_reports (status = 'approved'
   only — an IR only becomes a real, filed document once it's approved),
   all filtered to this project. project_files is looked up afterward, in
   one batched query, to resolve each row's project_file_id into an
   openable document.
=========================================================== */

(function () {
    "use strict";

    const VPO_TABLE = "vpos";
    const BC_TABLE = "back_charges";
    const IR_TABLE = "incident_reports";
    const PROJECT_FILES_TABLE = "project_files";

    // Filed BC/VPO/IR documents always land in project-documents (never
    // form-submissions) — see js/bc-vpo-docs.js's fileFilledDocument() and
    // the incident report filing flow in js/account-activity.js. Still
    // read file.bucket off the row rather than hardcoding it, same as
    // js/project-files.js does, in case that ever changes.
    const PROJECT_DOCS_BUCKET = "project-documents";

    let currentProject = null;
    let projectFilesById = {}; // { [project_files.id]: { storage_path, bucket, file_name } }

    /* ---------- helpers ---------- */

    function escapeHtmlFormLogs(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function truncateFormLogText(text, max) {
        if (!text) return "";
        return text.length > max ? `${text.slice(0, max).trim()}…` : text;
    }

    // richTextToPlainText/formatIncidentReportCurrency/formatIncidentReportDate
    // come from js/incident-report-pdf.js (loaded before this file on
    // project-form-logs.html) — defensive fallbacks here in case that
    // script fails to load, so this page degrades instead of throwing.
    function formLogsPlainText(html) {
        if (window.IncidentReportPdf?.richTextToPlainText) return window.IncidentReportPdf.richTextToPlainText(html);
        return (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    function formLogsFormatDate(dateStr) {
        if (window.IncidentReportPdf?.formatIncidentReportDate) return window.IncidentReportPdf.formatIncidentReportDate(dateStr);
        return dateStr || "—";
    }

    function formLogsFormatCurrency(value) {
        if (window.IncidentReportPdf?.formatIncidentReportCurrency) return window.IncidentReportPdf.formatIncidentReportCurrency(value);
        if (value === null || value === undefined || value === "") return "—";
        const num = Number(value);
        return Number.isNaN(num) ? "—" : `$${num.toFixed(2)}`;
    }

    function setFormLogsPageMessage(text, type) {
        const el = document.getElementById("formLogsPageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; return; }
        el.textContent = text;
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = "block";
    }

    /* ---------- opening a filed document ---------- */

    async function openFiledDocument(fileId) {
        const file = projectFilesById[fileId];
        if (!file) return;

        const { data, error } = await window.supabaseClient
            .storage
            .from(file.bucket || PROJECT_DOCS_BUCKET)
            .createSignedUrl(file.storage_path, 60 * 5);

        if (error || !data?.signedUrl) {
            console.error("Failed to create signed URL for filed document:", error);
            setFormLogsPageMessage("Couldn't open that document. Please try again.", "error");
            return;
        }

        window.open(data.signedUrl, "_blank", "noopener");
    }

    /* ---------- row -> table cell markup ---------- */

    function idCellHtml(idText, projectFileId) {
        const label = escapeHtmlFormLogs(idText || "—");
        if (projectFileId && projectFilesById[projectFileId]) {
            return `<span class="form-log-id-link" data-file-id="${projectFileId}" role="button" tabindex="0">${label}</span>`;
        }
        return `<span class="form-log-id-unfiled" title="Not filed into Project Files yet">${label}</span>`;
    }

    function rowHtml({ idText, projectFileId, vendor, date, comment, amount }) {
        return `
            <tr>
                <td>${idCellHtml(idText, projectFileId)}</td>
                <td>${escapeHtmlFormLogs(vendor || "—")}</td>
                <td>${escapeHtmlFormLogs(formLogsFormatDate(date))}</td>
                <td title="${escapeHtmlFormLogs(comment || "")}">${escapeHtmlFormLogs(truncateFormLogText(comment || "—", 90))}</td>
                <td>${escapeHtmlFormLogs(formLogsFormatCurrency(amount))}</td>
            </tr>
        `;
    }

    function vendorForBc(row) {
        const parts = [];
        if (row.vendor_to_charge_name) parts.push(`Charge: ${row.vendor_to_charge_name}`);
        if (row.vendor_to_cr_back_name) parts.push(`Credit: ${row.vendor_to_cr_back_name}`);
        return parts.join(" · ");
    }

    /* ---------- rendering ---------- */

    function renderFormLogSection(kind, rows) {
        const loadingEl = document.getElementById(`formLogs${kind}Loading`);
        const emptyEl = document.getElementById(`formLogs${kind}Empty`);
        const wrapEl = document.getElementById(`formLogs${kind}TableWrap`);
        const bodyEl = document.getElementById(`formLogs${kind}Body`);
        if (loadingEl) loadingEl.style.display = "none";
        if (!bodyEl || !wrapEl || !emptyEl) return;

        if (!rows.length) {
            wrapEl.style.display = "none";
            emptyEl.style.display = "block";
            bodyEl.innerHTML = "";
            return;
        }

        emptyEl.style.display = "none";
        wrapEl.style.display = "block";

        bodyEl.innerHTML = rows.map(row => {
            if (kind === "Vpo") {
                return rowHtml({
                    idText: row.vpo_number,
                    projectFileId: row.project_file_id,
                    vendor: row.vendor_name,
                    date: row.report_date,
                    comment: formLogsPlainText(row.reason_for_report),
                    amount: row.price,
                });
            }
            if (kind === "Bc") {
                return rowHtml({
                    idText: row.bc_number,
                    projectFileId: row.project_file_id,
                    vendor: vendorForBc(row),
                    date: row.report_date,
                    comment: formLogsPlainText(row.reason_for_report),
                    amount: row.price,
                });
            }
            // Ir
            return rowHtml({
                idText: row.ir_number,
                projectFileId: row.project_file_id,
                vendor: row.who_caused_issue,
                date: row.report_date,
                comment: formLogsPlainText(row.reason_for_report),
                amount: row.price,
            });
        }).join("");

        bodyEl.querySelectorAll(".form-log-id-link").forEach(el => {
            el.addEventListener("click", () => openFiledDocument(el.dataset.fileId));
            el.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFiledDocument(el.dataset.fileId); }
            });
        });
    }

    function showFormLogsLoadFailure() {
        ["Vpo", "Bc", "Ir"].forEach(kind => {
            const loadingEl = document.getElementById(`formLogs${kind}Loading`);
            if (loadingEl) loadingEl.style.display = "none";
        });
        setFormLogsPageMessage("Couldn't load this project's form logs. Please try again.", "error");
    }

    /* ---------- loading ---------- */

    async function loadProjectFilesFor(fileIds) {
        projectFilesById = {};
        const uniqueIds = [...new Set(fileIds.filter(Boolean))];
        if (!uniqueIds.length) return;

        const { data, error } = await window.supabaseClient
            .from(PROJECT_FILES_TABLE)
            .select("id, storage_path, bucket, file_name")
            .in("id", uniqueIds);

        if (error) {
            console.error("Failed to load filed documents:", error);
            return; // rows without a resolvable file just render as "not filed yet"
        }

        (data || []).forEach(file => { projectFilesById[file.id] = file; });
    }

    async function loadFormLogsData(projectId) {
        const [vpoResult, bcResult, irResult] = await Promise.all([
            window.supabaseClient
                .from(VPO_TABLE)
                .select("*")
                .eq("project_id", projectId)
                .order("created_at", { ascending: false }),
            window.supabaseClient
                .from(BC_TABLE)
                .select("*")
                .eq("project_id", projectId)
                .order("created_at", { ascending: false }),
            window.supabaseClient
                .from(IR_TABLE)
                .select("*")
                .eq("project_id", projectId)
                .eq("status", "approved")
                .order("report_date", { ascending: false }),
        ]);

        if (vpoResult.error || bcResult.error || irResult.error) {
            console.error("Failed to load project form logs:", vpoResult.error || bcResult.error || irResult.error);
            showFormLogsLoadFailure();
            return;
        }

        const vpoRows = vpoResult.data || [];
        const bcRows = bcResult.data || [];
        const irRows = irResult.data || [];

        const fileIds = [
            ...vpoRows.map(r => r.project_file_id),
            ...bcRows.map(r => r.project_file_id),
            ...irRows.map(r => r.project_file_id),
        ];
        await loadProjectFilesFor(fileIds);

        renderFormLogSection("Vpo", vpoRows);
        renderFormLogSection("Bc", bcRows);
        renderFormLogSection("Ir", irRows);
    }

    /* ---------- init ---------- */

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;
        currentProject = project;

        const heroNameEl = document.getElementById("formLogsHeroName");

        if (error || !project) {
            setFormLogsPageMessage("No project selected. Pick one from Project Overview.", "error");
            showFormLogsLoadFailure();
            return;
        }

        if (heroNameEl) heroNameEl.textContent = `Form Logs — ${project.name || "Untitled project"}`;

        await loadFormLogsData(project.id);
    });
})();
