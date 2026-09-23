/* ===========================================================
   BC / VPO — TEMPLATE FILL + FILING (Phase 2)

   Shared by pages/account-activity.html's BC and VPO popups. The two
   templates turned out to be structurally identical (see
   claude/incident-report-feature.md-style notes in
   sql/supabase-bc-vpo-setup.sql) -- same info table, same Building
   Number/Unit Number/Amount line-items table -- just tagged with their
   own {FIELD} names. So this is one kind-parameterized module rather than
   two near-duplicate ones.

   Fill mechanism: docxtemplater + pizzip (loaded before this file, see
   pages/account-activity.html) -- reads the uploaded .docx template as a
   zip, replaces every {FIELD_NAME} tag with real data, keeping every bit
   of the template's own formatting/logo/layout untouched (this is text
   substitution inside the existing Word XML, not a redraw). Confirmed
   against Coleby's actual templates -- see the filled-demo files sent
   earlier in this project's history.

   Template resolution: a project-specific template (bc_project_templates
   / vpo_project_templates) if one's been uploaded for this project,
   otherwise the company default (bc_default_template /
   vpo_default_template). Uploading either is also handled here (see
   uploadTemplate()) so the BC/VPO popups can offer "replace the template
   for this project" inline rather than needing a separate settings page.

   Filing: the filled .docx goes into the SAME project-documents bucket
   the rest of the app already uses (not a new bucket -- only the raw,
   pre-fill templates get their own private buckets), and gets indexed in
   project_files same as everything else project Files shows. BC files
   under 06 Construction -> Incident Report (same folder as the IR itself,
   per Coleby's spec). VPO files under 05 Contracts & Procurement -> VPO
   -- the taxonomy in js/project-fields.js already had a VPO folder
   sitting there unused; using it instead of piling VPO into the Incident
   Report folder too. Flagging that choice -- the original spec didn't
   say where VPOs should file, only that they should.
=========================================================== */

window.BcVpoDocs = (function () {
    "use strict";

    const PROJECT_DOCS_BUCKET = "project-documents";

    const KIND = {
        bc: {
            templatesBucket: "bc-templates",
            defaultTemplateTable: "bc_default_template",
            projectTemplateTable: "bc_project_templates",
            recordTable: "back_charges",
            idTagName: "ID_HERE",
            fileLabel: "Back Charge",
            category: "construction",
            subfolder: "incident_report",
            source: "back_charge",
            recordIdColumn: "back_charge_id",
            // Shipped with the app itself (see assets/templates/) -- the
            // actual tagged template built and confirmed against Coleby's
            // real BC template earlier in this project. Used automatically
            // whenever nobody's uploaded a project-specific or company
            // default template yet, so a BC/VPO never hard-fails with "no
            // template uploaded" -- Coleby's explicit call: "it should use
            // the default one that was given before ... dont remake it
            // jsut use the form [that was already given]."
            bundledPath: "/assets/templates/bc-default-template.docx",
            bundledFileName: "BC Default Template.docx",
        },
        vpo: {
            templatesBucket: "vpo-templates",
            defaultTemplateTable: "vpo_default_template",
            projectTemplateTable: "vpo_project_templates",
            recordTable: "vpos",
            idTagName: "VPO_ID",
            fileLabel: "VPO",
            category: "contracts_procurement",
            subfolder: "vpo",
            source: "vpo",
            recordIdColumn: "vpo_id",
            bundledPath: "/assets/templates/vpo-default-template.docx",
            bundledFileName: "VPO Template.docx",
        },
    };

    function kindConfig(kind) {
        const cfg = KIND[kind];
        if (!cfg) throw new Error(`Unknown BC/VPO kind: ${kind}`);
        return cfg;
    }

    /* ---------- shared tag data (everything that comes off the IR) ---------- */

    function plainText(html) {
        if (!html) return "";
        try {
            return window.IncidentReportPdf.richTextToPlainText(html) || "";
        } catch {
            return String(html);
        }
    }

    function money(value) {
        if (value === null || value === undefined || value === "") return "";
        try {
            return window.IncidentReportPdf.formatIncidentReportCurrency(value) || "";
        } catch {
            return String(value);
        }
    }

    function dateStr(value) {
        if (!value) return "";
        try {
            return window.IncidentReportPdf.formatIncidentReportDate(value) || "";
        } catch {
            return String(value);
        }
    }

    // report: the incident_reports row (or a back_charges/vpos row, which
    // carries the same field names -- both are snapshots of the IR).
    function buildCommonTags(report, project) {
        return {
            PROJECT_NAME: project?.name || "",
            EFFECTIVE_DATE: dateStr(report.report_date),
            REQUESTED_BY: report.person_making_report || "",
            REASON: plainText(report.reason_for_report),
            CHANGE_IN_SCOPE: plainText(report.change_in_scope) || "None",
            ITEM_1_BUILDING: report.buildings || "",
            ITEM_1_UNIT: report.unit_numbers || "",
            ITEM_1_AMOUNT: money(report.price),
            ITEM_2_BUILDING: "",
            ITEM_2_UNIT: "",
            ITEM_2_AMOUNT: "",
            TOTAL_AMOUNT: money(report.price),
        };
    }

    /* ---------- template resolution ---------- */

    // Returns { source: 'project' | 'default' | 'bundled', fileName, storagePath }.
    // There's no "none" case any more -- a project template wins, then the
    // company default (once Coleby uploads one via "Replace template"),
    // and failing both, the bundled template shipped with the app itself.
    // A BC/VPO can always be created; it just says which template it used.
    async function getTemplateStatus(kind, projectId) {
        const cfg = kindConfig(kind);

        if (projectId) {
            const { data: projectRow, error: projectErr } = await window.supabaseClient
                .from(cfg.projectTemplateTable)
                .select("storage_path, file_name")
                .eq("project_id", projectId)
                .maybeSingle();
            if (projectErr) console.warn(`Couldn't check for a project ${kind} template:`, projectErr);
            if (projectRow?.storage_path) {
                return { source: "project", fileName: projectRow.file_name, storagePath: projectRow.storage_path };
            }
        }

        const { data: defaultRow, error: defaultErr } = await window.supabaseClient
            .from(cfg.defaultTemplateTable)
            .select("storage_path, file_name")
            .eq("id", true)
            .maybeSingle();
        if (defaultErr) console.warn(`Couldn't check for the default ${kind} template:`, defaultErr);
        if (defaultRow?.storage_path) {
            return { source: "default", fileName: defaultRow.file_name, storagePath: defaultRow.storage_path };
        }

        return { source: "bundled", fileName: cfg.bundledFileName, storagePath: cfg.bundledPath };
    }

    // Loads the actual template bytes for whatever getTemplateStatus()
    // resolved to -- a Supabase Storage download for 'project'/'default',
    // or a plain same-origin fetch of the static asset for 'bundled'
    // (bundledPath is a real file under assets/templates/, not a Storage
    // path, so it can't go through the Storage API).
    async function loadTemplateBytes(kind, templateStatus) {
        if (templateStatus.source === "bundled") {
            const res = await fetch(templateStatus.storagePath);
            if (!res.ok) throw new Error(`Couldn't load the built-in ${kind.toUpperCase()} template.`);
            return new Uint8Array(await res.arrayBuffer());
        }
        const cfg = kindConfig(kind);
        const { data, error } = await window.supabaseClient.storage.from(cfg.templatesBucket).download(templateStatus.storagePath);
        if (error) throw error;
        return new Uint8Array(await data.arrayBuffer());
    }

    // projectId null/undefined -> replaces the company default. Otherwise
    // replaces (upserts) this project's own template.
    async function uploadTemplate(kind, projectId, file, staffId, staffName) {
        const cfg = kindConfig(kind);
        if (!file) throw new Error("No file selected.");
        if (!/\.docx$/i.test(file.name)) throw new Error("Templates must be a .docx file.");

        const storagePath = projectId
            ? `${projectId}/${Date.now()}-${file.name}`
            : `default/${Date.now()}-${file.name}`;

        const { error: uploadError } = await window.supabaseClient.storage
            .from(cfg.templatesBucket)
            .upload(storagePath, file, { cacheControl: "3600", upsert: true, contentType: file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        if (uploadError) throw uploadError;

        if (projectId) {
            const { error } = await window.supabaseClient
                .from(cfg.projectTemplateTable)
                .upsert({
                    project_id: projectId,
                    storage_path: storagePath,
                    file_name: file.name,
                    uploaded_by_id: staffId || null,
                    uploaded_by_name: staffName || null,
                    uploaded_at: new Date().toISOString(),
                }, { onConflict: "project_id" });
            if (error) throw error;
        } else {
            const { error } = await window.supabaseClient
                .from(cfg.defaultTemplateTable)
                .update({
                    storage_path: storagePath,
                    file_name: file.name,
                    uploaded_by_id: staffId || null,
                    uploaded_by_name: staffName || null,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", true);
            if (error) throw error;
        }
    }

    /* ---------- fill ---------- */

    function fillTemplate(templateBytes, tagData) {
        const zip = new PizZip(templateBytes);
        let doc;
        try {
            doc = new window.docxtemplater(zip, {
                paragraphLoop: true,
                linebreaks: true,
                nullGetter: () => "",
            });
        } catch (err) {
            throw new Error("This template couldn't be read as a .docx file — it may be corrupted or in the wrong format.");
        }
        try {
            doc.render(tagData);
        } catch (err) {
            const detail = err?.properties?.errors?.map(e => e.properties?.explanation).filter(Boolean).join("; ");
            throw new Error(detail ? `Template has a problem: ${detail}` : "Couldn't fill this template — check its {FIELD_NAME} tags for typos.");
        }
        return doc.getZip().generate({ type: "uint8array" });
    }

    /* ---------- file the filled document into Project Files ---------- */

    async function fileFilledDocument(kind, { projectId, recordId, filledBytes, fileName, staffName }) {
        const cfg = kindConfig(kind);
        const storagePath = `${projectId}/${cfg.category}/${cfg.subfolder}/${Date.now()}-${fileName}`;

        const { error: uploadError } = await window.supabaseClient.storage
            .from(PROJECT_DOCS_BUCKET)
            .upload(storagePath, new Blob([filledBytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), {
                cacheControl: "3600",
                upsert: true,
                contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            });
        if (uploadError) throw uploadError;

        const fileRow = {
            project_id: projectId,
            category: cfg.category,
            subfolder: cfg.subfolder,
            bucket: PROJECT_DOCS_BUCKET,
            storage_path: storagePath,
            file_name: fileName,
            source: cfg.source,
            uploaded_by_name: staffName || null,
        };
        fileRow[cfg.recordIdColumn] = recordId;

        const { data: filedRow, error: fileError } = await window.supabaseClient
            .from("project_files")
            .insert(fileRow)
            .select()
            .single();
        if (fileError) throw fileError;

        return filedRow;
    }

    // The one call the popups make: resolve the template, fill it, file
    // it, and update the back_charges/vpos row with where it landed.
    // `extraTags` carries whatever the kind-specific popup collected
    // (BC's two vendors, or VPO's one) plus the ID tag itself.
    async function fillAndFile(kind, { report, project, recordId, docNumber, extraTags, staffName }) {
        const cfg = kindConfig(kind);

        const templateStatus = await getTemplateStatus(kind, project?.id);
        const templateBytes = await loadTemplateBytes(kind, templateStatus);

        const tagData = Object.assign(
            { [cfg.idTagName]: docNumber },
            buildCommonTags(report, project),
            extraTags || {}
        );

        const filledBytes = fillTemplate(templateBytes, tagData);
        const fileName = `${cfg.fileLabel} - ${docNumber}.docx`;

        const filedRow = await fileFilledDocument(kind, {
            projectId: report.project_id,
            recordId,
            filledBytes,
            fileName,
            staffName,
        });

        const nowIso = new Date().toISOString();
        const { error: updateError } = await window.supabaseClient
            .from(cfg.recordTable)
            .update({
                project_file_id: filedRow.id,
                filed_at: nowIso,
                template_source: templateStatus.source,
                template_storage_path: templateStatus.storagePath,
            })
            .eq("id", recordId);
        if (updateError) throw updateError;

        return { projectFileId: filedRow.id, filedAt: nowIso, fileName, templateSource: templateStatus.source };
    }

    return {
        getTemplateStatus,
        uploadTemplate,
        fillAndFile,
    };
})();
