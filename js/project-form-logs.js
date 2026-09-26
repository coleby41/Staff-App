/* ===========================================================
   FORM LOGS (project-form-logs.html)

   Per-project log of every VPO, Back Charge, and approved Incident Report
   — three tables (ID | Vendor | Date | Comment | Amount), VPO/BC also
   getting an "IR ID" column linking back to the source incident report
   (Coleby: "link the ID of the IR and make it a collum on both the BC and
   the VPO" — not on the IR table itself, its own ID column already IS
   that id) and an Actions column with a Delete button (IR deletion
   already lives on Account Activity — this page doesn't duplicate it).
   Clicking an ID (either column) opens that row's filed document (a
   signed URL into the project-documents bucket), when one exists; rows
   that haven't been filed yet (e.g. a BC/VPO whose template-fill step
   failed — see the graceful-degradation handling in confirmBc()/
   confirmVpo() in js/account-activity.js) show a plain, unlinked "not
   filed yet" id instead of a dead link.

   Waits for the "project-shell:ready" event (project-shell.js) to know
   which project we're on, then owns everything below the header/sidebar.

   Tables read: vpos, back_charges, incident_reports (status = 'approved'
   only — an IR only becomes a real, filed document once it's approved),
   all filtered to this project. project_files is looked up afterward, in
   one batched query, to resolve each row's project_file_id into an
   openable document.

   Deleting a BC/VPO (delete_bc_with_cleanup / delete_vpo_with_cleanup RPCs,
   see sql/supabase-bc-vpo-setup.sql section 10) reclaims its number — the
   next one created takes its place, same convention as
   delete_incident_report_with_cleanup()/reclaim_incident_report_number()
   for incident reports — but ONLY when the deleted row held the current
   top of its project's (and, for VPO, its building's) counter; deleting
   from the middle of the sequence still just leaves a gap, same tradeoff
   IR numbering already makes.
=========================================================== */

(function () {
    "use strict";

    const VPO_TABLE = "vpos";
    const BC_TABLE = "back_charges";
    const IR_TABLE = "incident_reports";
    const PROJECT_FILES_TABLE = "project_files";

    // Coleby: only show the 4 newest per card, with a "Show All" popup for
    // the rest — same cap/popup shape as Account Activity's Form
    // Submissions section (AA_FORMS_SHOWN there).
    const FORM_LOGS_SHOWN = 4;

    // Which RPC deletes each kind — see sql/supabase-bc-vpo-setup.sql
    // section 10. No entry for "Ir" on purpose: IR deletion lives on
    // Account Activity (deleteReport() in js/account-activity.js), not here.
    const DELETE_RPC = { Vpo: "delete_vpo_with_cleanup", Bc: "delete_bc_with_cleanup" };
    const KIND_LABEL = { Vpo: "VPO", Bc: "Back Charge" };

    // Which kinds get an "IR ID" column linking back to the source
    // incident report — VPO/BC only (both snapshot incident_report_id at
    // creation, see sql/supabase-bc-vpo-setup.sql sections 3/5). Not "Ir"
    // itself — its own ID column already IS the IR's id, a second column
    // would just repeat it.
    const HAS_IR_LINK = { Vpo: true, Bc: true };

    // Filed BC/VPO/IR documents always land in project-documents (never
    // form-submissions) — see js/bc-vpo-docs.js's fileFilledDocument() and
    // the incident report filing flow in js/account-activity.js. Still
    // read file.bucket off the row rather than hardcoding it, same as
    // js/project-files.js does, in case that ever changes.
    const PROJECT_DOCS_BUCKET = "project-documents";

    let currentProject = null;
    let projectFilesById = {}; // { [project_files.id]: { storage_path, bucket, file_name } }
    let incidentReportsById = {}; // { [incident_reports.id]: { ir_number, project_file_id } } -- for the VPO/BC "IR ID" column
    let rowsByKindId = { Vpo: {}, Bc: {} }; // [kind][row.id] -> full row, for the delete handler
    let allRowsByKind = { Vpo: [], Bc: [], Ir: [] }; // the FULL row set per kind (not just the 4 shown) -- feeds the card total and the Show All popup
    let openPopupKind = null; // which kind's Show All popup is currently open, if any -- so a delete made from inside it can refresh the popup itself, not just the card underneath

    function formLogsCan(permissionKey) {
        return window.Permissions ? window.Permissions.hasPermission(permissionKey) : true;
    }

    // Same permission that gates deleting a filed incident report — BC/VPO
    // are downstream of that same approval workflow, so this reuses the key
    // rather than introducing a new one that would need its own catalog
    // entry and workgroup grants (see claude/permissions-system-implementation.md).
    function canDeleteFormLogs() {
        return formLogsCan("incident_reports.delete_filed_report");
    }

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

    /* ---------- deleting a BC/VPO ---------- */

    // Removes the filed document's actual Storage object first (the RPC
    // can only clean up the DB rows — Postgres itself can't reach Storage),
    // then calls delete_bc_with_cleanup/delete_vpo_with_cleanup, whose
    // AFTER DELETE trigger reclaims the BC/VPO number if this row held the
    // current top of its project's (and, for VPO, its building's) counter
    // — see sql/supabase-bc-vpo-setup.sql section 10. Same shape as
    // deleteReport() in js/account-activity.js.
    async function deleteFormLogRow(kind, rowId, btnEl) {
        const rpcName = DELETE_RPC[kind];
        if (!rpcName || !canDeleteFormLogs()) return;

        const row = rowsByKindId[kind]?.[rowId];
        const label = KIND_LABEL[kind] || "record";
        if (!window.confirm(`Delete this ${label}? This can't be undone.`)) return;

        if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Deleting…"; }
        try {
            const filedFile = row?.project_file_id ? projectFilesById[row.project_file_id] : null;
            if (filedFile) {
                const bucket = filedFile.bucket || PROJECT_DOCS_BUCKET;
                await window.supabaseClient.storage.from(bucket).remove([filedFile.storage_path]);
            }
            const { error } = await window.supabaseClient.rpc(rpcName, { p_id: rowId });
            if (error) throw error;
            if (currentProject?.id) await loadFormLogsData(currentProject.id);
        } catch (error) {
            console.error(`Failed to delete ${label}:`, error);
            setFormLogsPageMessage(error.message || `Something went wrong deleting this ${label}. Please try again.`, "error");
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Delete"; }
        }
    }

    /* ---------- row -> table cell markup ---------- */

    function idCellHtml(idText, projectFileId) {
        const label = escapeHtmlFormLogs(idText || "—");
        if (projectFileId && projectFilesById[projectFileId]) {
            return `<span class="form-log-id-link" data-file-id="${projectFileId}" role="button" tabindex="0">${label}</span>`;
        }
        return `<span class="form-log-id-unfiled" title="Not filed into Project Files yet">${label}</span>`;
    }

    function actionsCellHtml(kind, rowId) {
        if (!DELETE_RPC[kind]) return ""; // Ir has no Actions column at all — see below
        if (!canDeleteFormLogs()) return `<td></td>`;
        return `<td><button type="button" class="workbook-btn workbook-btn--danger form-log-delete-btn" data-kind="${kind}" data-id="${escapeHtmlFormLogs(rowId)}">Delete</button></td>`;
    }

    // includeActions defaults true and is shared by the main card tables
    // AND the Show All popup — the popup now mirrors the card exactly
    // (Coleby: "make the new popup to have everything in the table"), so
    // there's no longer a reason for it to pass false here. actionsCellHtml()
    // still omits the column entirely for "Ir", which has none either way.
    // irNumber/irProjectFileId are only ever set for Vpo/Bc (see
    // buildRowData()) — the IR ID column itself is gated by HAS_IR_LINK, so
    // passing them for "Ir" would just be ignored.
    function rowHtml({ kind, id, idText, projectFileId, vendor, date, comment, amount, irNumber, irProjectFileId, includeActions = true }) {
        return `
            <tr>
                <td>${idCellHtml(idText, projectFileId)}</td>
                ${HAS_IR_LINK[kind] ? `<td>${idCellHtml(irNumber, irProjectFileId)}</td>` : ""}
                <td>${escapeHtmlFormLogs(vendor || "—")}</td>
                <td>${escapeHtmlFormLogs(formLogsFormatDate(date))}</td>
                <td title="${escapeHtmlFormLogs(comment || "")}">${escapeHtmlFormLogs(truncateFormLogText(comment || "—", 90))}</td>
                <td>${escapeHtmlFormLogs(formLogsFormatCurrency(amount))}</td>
                ${includeActions ? actionsCellHtml(kind, id) : ""}
            </tr>
        `;
    }

    function vendorForBc(row) {
        const parts = [];
        if (row.vendor_to_charge_name) parts.push(`Charge: ${row.vendor_to_charge_name}`);
        if (row.vendor_to_cr_back_name) parts.push(`Credit: ${row.vendor_to_cr_back_name}`);
        return parts.join(" · ");
    }

    // Shared by the main card render and the Show All popup, so both
    // always agree on how a raw vpos/back_charges/incident_reports row
    // turns into a table row — this used to be inlined in
    // renderFormLogSection()'s own .map() only.
    function buildRowData(kind, row) {
        if (kind === "Vpo") {
            const irRow = incidentReportsById[row.incident_report_id];
            return {
                kind, id: row.id,
                idText: row.vpo_number,
                projectFileId: row.project_file_id,
                vendor: row.vendor_name,
                date: row.report_date,
                comment: formLogsPlainText(row.reason_for_report),
                amount: row.price,
                irNumber: irRow?.ir_number,
                irProjectFileId: irRow?.project_file_id,
            };
        }
        if (kind === "Bc") {
            const irRow = incidentReportsById[row.incident_report_id];
            return {
                kind, id: row.id,
                idText: row.bc_number,
                projectFileId: row.project_file_id,
                vendor: vendorForBc(row),
                date: row.report_date,
                comment: formLogsPlainText(row.reason_for_report),
                amount: row.price,
                irNumber: irRow?.ir_number,
                irProjectFileId: irRow?.project_file_id,
            };
        }
        // Ir — no delete column on this page (see header comment)
        return {
            kind, id: row.id,
            idText: row.ir_number,
            projectFileId: row.project_file_id,
            vendor: row.who_caused_issue,
            date: row.report_date,
            comment: formLogsPlainText(row.reason_for_report),
            amount: row.price,
        };
    }

    /* ---------- rendering ---------- */

    function renderFormLogSection(kind, rows) {
        const loadingEl = document.getElementById(`formLogs${kind}Loading`);
        const emptyEl = document.getElementById(`formLogs${kind}Empty`);
        const wrapEl = document.getElementById(`formLogs${kind}TableWrap`);
        const bodyEl = document.getElementById(`formLogs${kind}Body`);
        const totalEl = document.getElementById(`formLogs${kind}Total`);
        const showAllWrapEl = document.getElementById(`formLogs${kind}ShowAllWrap`);
        const showAllBtnEl = document.getElementById(`formLogs${kind}ShowAllBtn`);
        if (loadingEl) loadingEl.style.display = "none";
        if (!bodyEl || !wrapEl || !emptyEl) return;

        allRowsByKind[kind] = rows;

        if (!rows.length) {
            wrapEl.style.display = "none";
            emptyEl.style.display = "block";
            bodyEl.innerHTML = "";
            if (totalEl) totalEl.textContent = "";
            if (showAllWrapEl) showAllWrapEl.classList.add("hidden");
            // Deleting the last row of a kind while its popup is open should
            // still clear the popup out to "0 records", not leave it showing
            // the row that was just deleted.
            if (openPopupKind === kind) renderShowAllPopupRows(kind);
            return;
        }

        emptyEl.style.display = "none";
        wrapEl.style.display = "block";

        // Total always reflects every record in the table, not just the 4
        // shown below it — Coleby: "on the top right of the title of the
        // card can we display ... the total". All three kinds keep their
        // dollar amount in the same `price` column.
        const total = rows.reduce((sum, row) => sum + (Number(row.price) || 0), 0);
        if (totalEl) totalEl.textContent = `Total: ${formLogsFormatCurrency(total)}`;

        if (kind === "Vpo" || kind === "Bc") {
            rowsByKindId[kind] = {};
            rows.forEach(row => { rowsByKindId[kind][row.id] = row; });
        }

        const visibleRows = rows.slice(0, FORM_LOGS_SHOWN);
        bodyEl.innerHTML = visibleRows.map(row => rowHtml(buildRowData(kind, row))).join("");

        if (showAllWrapEl && showAllBtnEl) {
            if (rows.length > FORM_LOGS_SHOWN) {
                showAllBtnEl.textContent = `Show All (${rows.length})`;
                showAllWrapEl.classList.remove("hidden");
            } else {
                showAllWrapEl.classList.add("hidden");
            }
        }

        bodyEl.querySelectorAll(".form-log-delete-btn").forEach(el => {
            el.addEventListener("click", () => deleteFormLogRow(el.dataset.kind, el.dataset.id, el));
        });

        bodyEl.querySelectorAll(".form-log-id-link").forEach(el => {
            el.addEventListener("click", () => openFiledDocument(el.dataset.fileId));
            el.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFiledDocument(el.dataset.fileId); }
            });
        });

        // If this kind's Show All popup is open right now, keep it in sync
        // too — otherwise a delete made from inside the popup (see
        // renderShowAllPopupRows()) would leave the popup showing a stale
        // row for the record that was just removed.
        if (openPopupKind === kind) renderShowAllPopupRows(kind);
    }

    /* ---------- "Show All" popup ---------- */

    const SHOW_ALL_TITLE = { Vpo: "VPO", Bc: "Back Charge", Ir: "Incident Report" };

    // Rebuilds just the popup's header row (Actions column only for
    // VPO/BC, same as the card — see actionsCellHtml()) and body rows.
    // Split out from openShowAllPopup() so a delete made from inside the
    // popup, or a refresh of the underlying data, can re-run this without
    // re-opening/re-animating the popup itself.
    function renderShowAllPopupRows(kind) {
        const rows = allRowsByKind[kind] || [];

        const subtitleEl = document.getElementById("formLogsShowAllSubtitle");
        if (subtitleEl) subtitleEl.textContent = `${rows.length} record${rows.length === 1 ? "" : "s"}`;

        const headRowEl = document.getElementById("formLogsShowAllHeadRow");
        if (headRowEl) {
            headRowEl.innerHTML = `<th>ID</th>${HAS_IR_LINK[kind] ? "<th>IR ID</th>" : ""}<th>Vendor</th><th>Date</th><th>Comment</th><th>Amount</th>${DELETE_RPC[kind] ? "<th>Actions</th>" : ""}`;
        }

        const bodyEl = document.getElementById("formLogsShowAllBody");
        if (!bodyEl) return;

        bodyEl.innerHTML = rows.map(row => rowHtml(buildRowData(kind, row))).join("");

        bodyEl.querySelectorAll(".form-log-delete-btn").forEach(el => {
            el.addEventListener("click", () => deleteFormLogRow(el.dataset.kind, el.dataset.id, el));
        });
        bodyEl.querySelectorAll(".form-log-id-link").forEach(el => {
            el.addEventListener("click", () => openFiledDocument(el.dataset.fileId));
            el.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFiledDocument(el.dataset.fileId); }
            });
        });
    }

    function openShowAllPopup(kind) {
        openPopupKind = kind;

        const titleEl = document.getElementById("formLogsShowAllTitle");
        if (titleEl) titleEl.textContent = `${SHOW_ALL_TITLE[kind] || kind} — all records`;

        renderShowAllPopupRows(kind);

        document.getElementById("formLogsShowAllOverlay")?.classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeShowAllPopup() {
        openPopupKind = null;
        document.getElementById("formLogsShowAllOverlay")?.classList.add("hidden");
        document.body.classList.remove("popup-active");
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

    // Batch-resolves each VPO/BC row's source incident report (ir_number +
    // its own project_file_id, so the new "IR ID" column can both label
    // and link) — same one-query-for-everyone-on-screen shape as
    // loadProjectFilesFor() above, keyed by incident_reports.id.
    async function loadIncidentReportsFor(incidentReportIds) {
        incidentReportsById = {};
        const uniqueIds = [...new Set(incidentReportIds.filter(Boolean))];
        if (!uniqueIds.length) return;

        const { data, error } = await window.supabaseClient
            .from(IR_TABLE)
            .select("id, ir_number, project_file_id")
            .in("id", uniqueIds);

        if (error) {
            console.error("Failed to load linked incident reports:", error);
            return; // rows without a resolvable IR just render a blank IR ID column
        }

        (data || []).forEach(ir => { incidentReportsById[ir.id] = ir; });
    }

    // Pulls the trailing integer off a formatted ID string -- "BC-TP-014" ->
    // 14, "IR-TP-003" -> 3. Used to sort BC/IR by their actual ID number
    // rather than by created_at/report_date (Coleby: "it needs to be by ID
    // Number"). Rows with no number yet (shouldn't normally happen -- both
    // are only ever created already-numbered) sort to the very end rather
    // than breaking the sort.
    function trailingIdNumber(idText) {
        const match = /(\d+)\s*$/.exec(idText || "");
        return match ? parseInt(match[1], 10) : -Infinity;
    }

    // Descending by ID number, newest/highest first (Coleby's answer:
    // "Newest first (highest number on top)") -- same feel as the previous
    // newest-first ordering, just keyed off the number itself so it can't
    // drift out of sync with creation order.
    function sortByIdNumberDesc(rows, numberOf) {
        return [...rows].sort((a, b) => numberOf(b) - numberOf(a));
    }

    async function loadFormLogsData(projectId) {
        const [vpoResult, bcResult, irResult] = await Promise.all([
            window.supabaseClient
                .from(VPO_TABLE)
                .select("*")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(BC_TABLE)
                .select("*")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(IR_TABLE)
                .select("*")
                .eq("project_id", projectId)
                .eq("status", "approved"),
        ]);

        if (vpoResult.error || bcResult.error || irResult.error) {
            console.error("Failed to load project form logs:", vpoResult.error || bcResult.error || irResult.error);
            showFormLogsLoadFailure();
            return;
        }

        // Sorted here (client-side) rather than via .order() in the queries
        // above, since VPO's ID number isn't a single column to order by --
        // "VPO-TP-3-1-7"'s meaningful sequence number is the trailing
        // project_total_at_creation, stored separately as a real integer
        // (see sql/supabase-bc-vpo-setup.sql section 4/5) -- while BC/IR's
        // number has to be parsed out of their text bc_number/ir_number.
        const vpoRows = sortByIdNumberDesc(vpoResult.data || [], r => r.project_total_at_creation ?? -Infinity);
        const bcRows = sortByIdNumberDesc(bcResult.data || [], r => trailingIdNumber(r.bc_number));
        const irRows = sortByIdNumberDesc(irResult.data || [], r => trailingIdNumber(r.ir_number));

        // Resolve each VPO/BC's source IR first, so its project_file_id
        // (needed to make the new "IR ID" column clickable) can be folded
        // into the same batched project_files lookup below.
        const incidentReportIds = [
            ...vpoRows.map(r => r.incident_report_id),
            ...bcRows.map(r => r.incident_report_id),
        ];
        await loadIncidentReportsFor(incidentReportIds);

        const fileIds = [
            ...vpoRows.map(r => r.project_file_id),
            ...bcRows.map(r => r.project_file_id),
            ...irRows.map(r => r.project_file_id),
            ...Object.values(incidentReportsById).map(ir => ir.project_file_id),
        ];
        await loadProjectFilesFor(fileIds);

        renderFormLogSection("Vpo", vpoRows);
        renderFormLogSection("Bc", bcRows);
        renderFormLogSection("Ir", irRows);
    }

    /* ---------- static wiring (elements exist at parse time — script tag is at the bottom of the page) ---------- */

    ["Vpo", "Bc", "Ir"].forEach(kind => {
        document.getElementById(`formLogs${kind}ShowAllBtn`)?.addEventListener("click", () => openShowAllPopup(kind));
    });
    document.getElementById("formLogsShowAllCloseBtn")?.addEventListener("click", closeShowAllPopup);
    document.getElementById("formLogsShowAllOverlay")?.addEventListener("click", (event) => {
        if (event.target.id === "formLogsShowAllOverlay") closeShowAllPopup();
    });

    /* ---------- "Submit Old Forms" (legacy migration entry point) ----------
       Button + amber "Legacy Feature" pill on the hero (see
       project-form-logs.html) -- opens a warning popup before going any
       further, since this is a temporary tool for backfilling old BC/VPO
       records that'll get phased out once that's done. "Go Back" and the
       backdrop both just close the popup and leave you on Form Logs, same
       convention as the Show All popup right above. "Continue" is wired up
       but intentionally a no-op for now -- the batch-upload/review flow it
       leads to (parse each old PDF client-side, show an editable table,
       "Create All") hasn't been built yet. */
    function openLegacyWarningPopup() {
        document.getElementById("formLogsLegacyWarningOverlay")?.classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeLegacyWarningPopup() {
        document.getElementById("formLogsLegacyWarningOverlay")?.classList.add("hidden");
        document.body.classList.remove("popup-active");
    }

    document.getElementById("formLogsSubmitOldFormsBtn")?.addEventListener("click", openLegacyWarningPopup);
    document.getElementById("formLogsLegacyGoBackBtn")?.addEventListener("click", closeLegacyWarningPopup);
    document.getElementById("formLogsLegacyWarningOverlay")?.addEventListener("click", (event) => {
        if (event.target.id === "formLogsLegacyWarningOverlay") closeLegacyWarningPopup();
    });

    // TODO(old-forms-migration): hook this up once the batch PDF-parse/
    // review flow exists. Intentionally does nothing right now -- Coleby:
    // "the continue will take them to nothing since we are still working
    // on it".
    document.getElementById("formLogsLegacyContinueBtn")?.addEventListener("click", () => {});

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
