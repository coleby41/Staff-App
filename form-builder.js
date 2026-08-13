/* ===========================
   FORM BUILDER
   Requires: window.supabaseClient (supabase-auth.js), pdfMake (form PDF
   generation), notifications.js (for the "view it here" link convention).

   Lets IT / Super Admin / Office (or whoever created a given form) build
   custom forms right in the app; any signed-in staff member can fill one
   out. Submitting generates a PDF (pdfMake, same library/pattern as the
   vendor report generator in companies.js), uploads it to a private bucket,
   and sends the submitter a notification with a link back to view it.

   Known limitation: editing a form's fields after people have already
   submitted doesn't retroactively update old submissions — each submission
   snapshots its own answers keyed by field id at the time it was filled
   out. If a field is later removed, that submission's PDF/record still has
   the original answer; the Responses list just labels it by its old id.
=========================== */

const FORM_TEMPLATES_TABLE = "form_templates";
const FORM_SUBMISSIONS_TABLE = "form_submissions";
const FORM_SUBMISSIONS_BUCKET = "form-submissions";
const FORM_TEMPLATE_SOURCES_BUCKET = "form-template-sources";

// Legacy (pre-PDF) field types — still used to edit older forms that were
// built the manual way (record.pdf_path is null).
const FORM_FIELD_TYPES = [
    { value: "short_text", label: "Short text" },
    { value: "paragraph", label: "Paragraph text" },
    { value: "dropdown", label: "Dropdown" },
    { value: "checkboxes", label: "Checkboxes (multiple choice)" },
    { value: "radio", label: "Multiple choice (single answer)" },
    { value: "date", label: "Date" },
    { value: "number", label: "Number" },
    { value: "section", label: "Section heading" }
];

const FORM_FIELD_TYPES_WITH_OPTIONS = ["dropdown", "checkboxes", "radio"];

// PDF-based field types — placed by click-dragging directly on the uploaded
// source PDF. New forms are always built this way.
const PDF_FIELD_TYPES = [
    { value: "text", label: "Text" },
    { value: "number", label: "Number" },
    { value: "date", label: "Date" },
    { value: "checkbox", label: "Checkbox" },
    { value: "dropdown", label: "Dropdown" },
    { value: "signature", label: "Signature" }
];

const PDF_RENDER_SCALE = 1.4;

let formRecords = [];
let editingFormRecord = null;   // the form_templates row being edited, or null for a new form
let editingFields = [];         // working copy of the fields array while the builder modal is open
let fillFormRecord = null;      // the form currently open in the fill-out modal
let editingSubmission = null;   // the form_submissions row being edited via the fill-out modal, or null when filling a brand-new response
let responsesFormRecord = null; // the form currently open in the Responses modal

// PDF builder state (form-template.html "New Form" / editing a PDF-based form)
let pdfBuilderDoc = null;         // pdf.js PDFDocumentProxy currently loaded in the builder
let pdfBuilderBytes = null;       // ArrayBuffer copy of that PDF, kept for upload (pdf.js consumes its own copy)
let pdfBuilderIsNewUpload = false; // true if pdfBuilderBytes came from a file picked this session (vs. an existing form's stored PDF)
let pdfBuilderPageCount = 0;
let pdfPopoverState = null;       // { pageIndex, overlay, x, y, width, height, fieldId } for the field currently being added/edited

// PDF fill-out state (form-template.html fill-out modal)
let fillPdfDoc = null; // pdf.js PDFDocumentProxy currently loaded in the fill-out modal

if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
}

/* ---------- helpers ---------- */

function formEscapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
}

function getFormStaffProfile() {
    return window.currentSupabaseProfile
        || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
}

function getFormStaffName() {
    const profile = getFormStaffProfile();
    return (profile && (profile.full_name || profile.username)) || "Staff";
}

function getFormStaffId() {
    const profile = getFormStaffProfile();
    return profile?.id || profile?.uid || null;
}

// IT / Super Admin / Office can manage (create/edit/delete) any form.
function canManageForms() {
    const profile = getFormStaffProfile();
    if (!window.isSupabaseUserInGroup) return false;
    return (
        window.isSupabaseUserInGroup(profile, "IT") ||
        window.isSupabaseUserInGroup(profile, "Super Admin") ||
        window.isSupabaseUserInGroup(profile, "Office")
    );
}

// Whoever created a specific form can also manage that one form, even if
// they're not in one of the groups above (e.g. their group changed later).
function canManageThisForm(record) {
    if (canManageForms()) return true;
    const myId = getFormStaffId();
    return Boolean(myId && record && record.created_by && String(record.created_by) === String(myId));
}

function fieldTypeLabel(type) {
    const match = FORM_FIELD_TYPES.find(t => t.value === type);
    return match ? match.label : type;
}

function pdfFieldTypeLabel(type) {
    const match = PDF_FIELD_TYPES.find(t => t.value === type);
    return match ? match.label : type;
}

function makeFieldId() {
    return `field_${Math.random().toString(36).slice(2, 10)}`;
}

function formatFormDate(isoString) {
    try {
        return new Date(isoString).toLocaleString(undefined, {
            month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
        });
    } catch {
        return isoString;
    }
}

function showFormPageMessage(text, type) {
    const el = document.getElementById("formPageMessage");
    if (!el) return;
    el.textContent = text;
    el.className = `workbook-page-message ${type || ""}`;
    el.style.display = "block";
    if (type === "success") setTimeout(() => { el.style.display = "none"; }, 4000);
}

/* ---------- loading + rendering the grid ---------- */

async function loadFormTemplates() {
    const loadingEl = document.getElementById("formLoadingState");
    const emptyEl = document.getElementById("formEmptyState");

    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        if (loadingEl) loadingEl.style.display = "none";
        showFormPageMessage("Couldn't connect to Supabase. Please refresh the page.", "error");
        return;
    }

    if (loadingEl) loadingEl.style.display = "block";
    if (emptyEl) emptyEl.style.display = "none";

    const { data, error } = await window.supabaseClient
        .from(FORM_TEMPLATES_TABLE)
        .select("*")
        .order("created_at", { ascending: false });

    if (loadingEl) loadingEl.style.display = "none";

    if (error) {
        console.error("Failed to load forms:", error);
        showFormPageMessage("Couldn't load the form library. Please try again.", "error");
        return;
    }

    formRecords = data || [];
    renderFormGrid();
}

function renderFormGrid() {
    const gridEl = document.getElementById("formGrid");
    const emptyEl = document.getElementById("formEmptyState");
    if (!gridEl) return;

    gridEl.innerHTML = "";

    if (formRecords.length === 0) {
        if (emptyEl) emptyEl.style.display = "block";
        return;
    }
    if (emptyEl) emptyEl.style.display = "none";

    formRecords.forEach(record => {
        gridEl.appendChild(buildFormCard(record));
    });
}

function buildFormCard(record) {
    const card = document.createElement("article");
    card.className = "workbook-card form-template-card";
    card.dataset.id = record.id;

    const canManage = canManageThisForm(record);
    const fieldCount = Array.isArray(record.fields) ? record.fields.filter(f => f.type !== "section").length : 0;

    card.innerHTML = `
        <div class="workbook-cover form-template-cover">
            ${canManage ? `
                <button type="button" class="workbook-edit-btn" data-action="edit" aria-label="Edit form">
                    <span class="company-edit-icon"></span>
                </button>
            ` : ""}
            <h3 class="workbook-cover-title">${formEscapeHtml(record.title)}</h3>
        </div>
        <div class="workbook-card-body">
            <p class="form-template-description">${formEscapeHtml(record.description || "")}</p>
            <div class="workbook-meta">
                <span class="workbook-meta-uploader">${formEscapeHtml(record.created_by_name || "Staff")}</span>
                <span class="workbook-meta-date">${fieldCount} question${fieldCount === 1 ? "" : "s"}</span>
            </div>
            <div class="workbook-actions">
                <button type="button" class="workbook-btn workbook-btn--preview" data-action="fill">Fill out</button>
                ${canManage ? `<button type="button" class="workbook-btn workbook-btn--download" data-action="responses">Responses</button>` : ""}
            </div>
        </div>
    `;

    card.querySelector('[data-action="fill"]').addEventListener("click", () => openFillFormModal(record));

    const editBtn = card.querySelector('[data-action="edit"]');
    if (editBtn) editBtn.addEventListener("click", (e) => { e.stopPropagation(); openFormBuilderModal(record); });

    const responsesBtn = card.querySelector('[data-action="responses"]');
    if (responsesBtn) responsesBtn.addEventListener("click", () => openResponsesModal(record));

    return card;
}

function prependFormCard(record) {
    formRecords.unshift(record);
    const emptyEl = document.getElementById("formEmptyState");
    if (emptyEl) emptyEl.style.display = "none";
    const gridEl = document.getElementById("formGrid");
    if (!gridEl) return;
    gridEl.insertBefore(buildFormCard(record), gridEl.firstChild);
}

function replaceFormCard(updated) {
    const index = formRecords.findIndex(r => r.id === updated.id);
    if (index !== -1) formRecords[index] = updated;

    const gridEl = document.getElementById("formGrid");
    const oldCard = gridEl?.querySelector(`[data-id="${updated.id}"]`);
    const newCard = buildFormCard(updated);
    if (oldCard) oldCard.replaceWith(newCard);
    else if (gridEl) gridEl.appendChild(newCard);
}

function removeFormCardFromDom(id) {
    const gridEl = document.getElementById("formGrid");
    gridEl?.querySelector(`[data-id="${id}"]`)?.remove();
    formRecords = formRecords.filter(r => r.id !== id);
    if (formRecords.length === 0) {
        const emptyEl = document.getElementById("formEmptyState");
        if (emptyEl) emptyEl.style.display = "block";
    }
}

/* ---------- builder modal: field editor ---------- */

function renderFieldEditorList() {
    const list = document.getElementById("formFieldsList");
    if (!list) return;
    list.innerHTML = "";

    if (!editingFields.length) {
        list.innerHTML = `<p class="auth-inline-copy">No questions yet — add one below.</p>`;
        return;
    }

    editingFields.forEach((field, index) => {
        list.appendChild(buildFieldEditorRow(field, index));
    });
}

function buildFieldEditorRow(field, index) {
    const row = document.createElement("div");
    row.className = "form-field-editor-row";
    row.dataset.fieldId = field.id;

    const needsOptions = FORM_FIELD_TYPES_WITH_OPTIONS.includes(field.type);
    const isSection = field.type === "section";

    row.innerHTML = `
        <div class="form-field-editor-top">
            <span class="form-field-type-badge">${formEscapeHtml(fieldTypeLabel(field.type))}</span>
            <div class="form-field-editor-controls">
                <button type="button" class="form-field-move-btn" data-action="move-up" aria-label="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
                <button type="button" class="form-field-move-btn" data-action="move-down" aria-label="Move down" ${index === editingFields.length - 1 ? "disabled" : ""}>↓</button>
                <button type="button" class="form-field-remove-btn" data-action="remove" aria-label="Remove question">✕</button>
            </div>
        </div>
        <label class="auth-field">
            ${isSection ? "Heading text" : "Question"}
            <input type="text" class="form-field-label-input" value="${formEscapeHtml(field.label || "")}" placeholder="${isSection ? "e.g. Contact Information" : "e.g. What's your full name?"}">
        </label>
        ${!isSection ? `
            <label class="form-field-required-row">
                <input type="checkbox" class="form-field-required-input" ${field.required ? "checked" : ""}>
                Required
            </label>
        ` : ""}
        ${needsOptions ? `
            <label class="auth-field">
                Options (one per line)
                <textarea class="form-field-options-input" rows="3" placeholder="Option A&#10;Option B&#10;Option C">${formEscapeHtml((field.options || []).join("\n"))}</textarea>
            </label>
        ` : ""}
    `;

    row.querySelector(".form-field-label-input").addEventListener("input", (e) => {
        editingFields[index].label = e.target.value;
    });

    const requiredInput = row.querySelector(".form-field-required-input");
    if (requiredInput) {
        requiredInput.addEventListener("change", (e) => {
            editingFields[index].required = e.target.checked;
        });
    }

    const optionsInput = row.querySelector(".form-field-options-input");
    if (optionsInput) {
        optionsInput.addEventListener("input", (e) => {
            editingFields[index].options = e.target.value
                .split("\n")
                .map(s => s.trim())
                .filter(Boolean);
        });
    }

    row.querySelector('[data-action="remove"]').addEventListener("click", () => {
        editingFields.splice(index, 1);
        renderFieldEditorList();
    });

    row.querySelector('[data-action="move-up"]').addEventListener("click", () => {
        if (index === 0) return;
        [editingFields[index - 1], editingFields[index]] = [editingFields[index], editingFields[index - 1]];
        renderFieldEditorList();
    });

    row.querySelector('[data-action="move-down"]').addEventListener("click", () => {
        if (index === editingFields.length - 1) return;
        [editingFields[index + 1], editingFields[index]] = [editingFields[index], editingFields[index + 1]];
        renderFieldEditorList();
    });

    return row;
}

function addFieldOfType(type) {
    editingFields.push({
        id: makeFieldId(),
        type,
        label: "",
        required: false,
        options: FORM_FIELD_TYPES_WITH_OPTIONS.includes(type) ? ["Option A", "Option B"] : []
    });
    renderFieldEditorList();
}

/* ---------- PDF builder: upload + render + place fields ---------- */

async function handlePdfFileSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const messageEl = document.getElementById("formBuilderMessage");

    if (file.type !== "application/pdf") {
        if (messageEl) { messageEl.textContent = "Please choose a PDF file."; messageEl.className = "auth-message error"; }
        event.target.value = "";
        return;
    }

    try {
        const arrayBuffer = await file.arrayBuffer();
        await loadPdfIntoBuilder(arrayBuffer, true);
    } catch (error) {
        console.error("Failed to read PDF file:", error);
        if (messageEl) { messageEl.textContent = "Couldn't read that PDF. Please try a different file."; messageEl.className = "auth-message error"; }
    } finally {
        event.target.value = ""; // allow re-selecting the same file later
    }
}

async function loadPdfIntoBuilder(arrayBuffer, isNewUpload) {
    const messageEl = document.getElementById("formBuilderMessage");

    if (typeof pdfjsLib === "undefined") {
        if (messageEl) { messageEl.textContent = "The PDF viewer failed to load. Refresh and try again."; messageEl.className = "auth-message error"; }
        return;
    }

    try {
        // pdf.js takes ownership of the buffer it's given, so keep our own
        // independent copy around for uploading to storage later.
        pdfBuilderBytes = arrayBuffer.slice(0);
        pdfBuilderIsNewUpload = isNewUpload;

        pdfBuilderDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
        pdfBuilderPageCount = pdfBuilderDoc.numPages;

        if (isNewUpload) {
            // A freshly uploaded PDF replaces whatever fields were placed
            // against the previous document (their coordinates wouldn't
            // line up with a different layout).
            editingFields = [];
        }

        const uploadPrompt = document.getElementById("formPdfUploadPrompt");
        const workspace = document.getElementById("formPdfWorkspace");
        const metaEl = document.getElementById("formPdfFileMeta");
        if (uploadPrompt) uploadPrompt.style.display = "none";
        if (workspace) workspace.style.display = "block";
        if (metaEl) metaEl.textContent = `${pdfBuilderPageCount} page${pdfBuilderPageCount === 1 ? "" : "s"}`;

        await renderPdfBuilderPages();
    } catch (error) {
        console.error("Failed to load PDF:", error);
        if (messageEl) { messageEl.textContent = "Couldn't read that PDF. Please try a different file."; messageEl.className = "auth-message error"; }
    }
}

async function loadExistingPdfIntoBuilder(path) {
    const messageEl = document.getElementById("formBuilderMessage");
    try {
        const { data, error } = await window.supabaseClient
            .storage
            .from(FORM_TEMPLATE_SOURCES_BUCKET)
            .download(path);
        if (error) throw error;

        const arrayBuffer = await data.arrayBuffer();
        await loadPdfIntoBuilder(arrayBuffer, false);
    } catch (error) {
        console.error("Failed to load existing form PDF:", error);
        if (messageEl) { messageEl.textContent = "Couldn't load this form's PDF. Please try again."; messageEl.className = "auth-message error"; }
    }
}

async function renderPdfBuilderPages() {
    const container = document.getElementById("formPdfPagesContainer");
    if (!container || !pdfBuilderDoc) return;
    container.innerHTML = "";

    for (let pageNum = 1; pageNum <= pdfBuilderPageCount; pageNum++) {
        const pageIndex = pageNum - 1;
        const page = await pdfBuilderDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });

        const pageWrap = document.createElement("div");
        pageWrap.className = "pdf-page";
        // Only width is set inline — height is left to flow from the canvas
        // (which preserves its own aspect ratio via CSS), so the whole page
        // scales down responsively if the popup is narrower than the PDF's
        // native render width (see .pdf-page / .pdf-page-canvas in styles.css).
        pageWrap.style.width = `${viewport.width}px`;

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.className = "pdf-page-canvas";

        const overlay = document.createElement("div");
        overlay.className = "pdf-page-overlay";

        pageWrap.appendChild(canvas);
        pageWrap.appendChild(overlay);
        container.appendChild(pageWrap);

        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

        wireBuilderPageDrawing(overlay, pageIndex);
        renderFieldBoxesForPage(overlay, pageIndex);
    }
}

// Click-and-drag on a page's overlay to draw a new field box.
function wireBuilderPageDrawing(overlay, pageIndex) {
    overlay.addEventListener("pointerdown", (e) => {
        if (e.target !== overlay) return; // let clicks on existing boxes open the edit popover instead
        e.preventDefault();

        const rect = overlay.getBoundingClientRect();
        const startX = e.clientX - rect.left;
        const startY = e.clientY - rect.top;

        const dragBox = document.createElement("div");
        dragBox.className = "pdf-field-box pdf-field-box--drawing";
        dragBox.style.left = `${startX}px`;
        dragBox.style.top = `${startY}px`;
        dragBox.style.width = "0px";
        dragBox.style.height = "0px";
        overlay.appendChild(dragBox);

        function onMove(moveEvt) {
            const r = overlay.getBoundingClientRect();
            const curX = moveEvt.clientX - r.left;
            const curY = moveEvt.clientY - r.top;
            const left = Math.min(startX, curX);
            const top = Math.min(startY, curY);
            dragBox.style.left = `${left}px`;
            dragBox.style.top = `${top}px`;
            dragBox.style.width = `${Math.abs(curX - startX)}px`;
            dragBox.style.height = `${Math.abs(curY - startY)}px`;
        }

        function onUp(upEvt) {
            overlay.removeEventListener("pointermove", onMove);
            overlay.removeEventListener("pointerup", onUp);

            const r = overlay.getBoundingClientRect();
            const left = parseFloat(dragBox.style.left);
            const top = parseFloat(dragBox.style.top);
            const width = parseFloat(dragBox.style.width);
            const height = parseFloat(dragBox.style.height);
            dragBox.remove();

            if (width < 12 || height < 10) return; // too small — treat as an accidental click

            openPdfFieldPopover(
                {
                    pageIndex,
                    overlay,
                    x: left / r.width,
                    y: top / r.height,
                    width: width / r.width,
                    height: height / r.height,
                    fieldId: null
                },
                { clientX: upEvt.clientX, clientY: upEvt.clientY }
            );
        }

        overlay.addEventListener("pointermove", onMove);
        overlay.addEventListener("pointerup", onUp);
    });
}

function renderFieldBoxesForPage(overlay, pageIndex) {
    overlay.querySelectorAll(".pdf-field-box:not(.pdf-field-box--drawing)").forEach(el => el.remove());

    editingFields
        .filter(f => f.page === pageIndex)
        .forEach(field => {
            const box = document.createElement("div");
            box.className = "pdf-field-box";
            box.style.left = `${field.x * 100}%`;
            box.style.top = `${field.y * 100}%`;
            box.style.width = `${field.width * 100}%`;
            box.style.height = `${field.height * 100}%`;
            box.innerHTML = `<span class="pdf-field-box-label">${formEscapeHtml(field.label || pdfFieldTypeLabel(field.type))}</span>`;

            box.addEventListener("click", (e) => {
                e.stopPropagation();
                openPdfFieldPopover(
                    { pageIndex, overlay, x: field.x, y: field.y, width: field.width, height: field.height, fieldId: field.id },
                    { clientX: e.clientX, clientY: e.clientY }
                );
            });

            overlay.appendChild(box);
        });
}

function openPdfFieldPopover(state, pointerPos) {
    pdfPopoverState = state;

    const popover = document.getElementById("pdfFieldPopover");
    const typeSelect = document.getElementById("pdfFieldTypeSelect");
    const labelInput = document.getElementById("pdfFieldLabelInput");
    const requiredInput = document.getElementById("pdfFieldRequiredInput");
    const optionsWrap = document.getElementById("pdfFieldOptionsWrap");
    const optionsInput = document.getElementById("pdfFieldOptionsInput");
    const deleteBtn = document.getElementById("pdfFieldDeleteBtn");
    if (!popover) return;

    const existing = state.fieldId ? editingFields.find(f => f.id === state.fieldId) : null;

    typeSelect.value = existing?.type || "text";
    labelInput.value = existing?.label || "";
    requiredInput.checked = Boolean(existing?.required);
    optionsInput.value = (existing?.options || []).join("\n");
    optionsWrap.style.display = typeSelect.value === "dropdown" ? "block" : "none";
    deleteBtn.style.display = existing ? "inline-block" : "none";

    popover.classList.remove("hidden");
    positionPdfPopover(popover, pointerPos.clientX, pointerPos.clientY);

    labelInput.focus();
}

function positionPdfPopover(popover, clientX, clientY) {
    const margin = 12;
    const popRect = popover.getBoundingClientRect();
    let left = clientX + margin;
    let top = clientY + margin;
    if (left + popRect.width > window.innerWidth - margin) left = window.innerWidth - popRect.width - margin;
    if (top + popRect.height > window.innerHeight - margin) top = window.innerHeight - popRect.height - margin;
    popover.style.left = `${Math.max(margin, left)}px`;
    popover.style.top = `${Math.max(margin, top)}px`;
}

function closePdfFieldPopover() {
    document.getElementById("pdfFieldPopover")?.classList.add("hidden");
    pdfPopoverState = null;
}

function handlePdfFieldSave() {
    if (!pdfPopoverState) return;

    const typeSelect = document.getElementById("pdfFieldTypeSelect");
    const labelInput = document.getElementById("pdfFieldLabelInput");
    const requiredInput = document.getElementById("pdfFieldRequiredInput");
    const optionsInput = document.getElementById("pdfFieldOptionsInput");

    const label = labelInput.value.trim();
    if (!label) { labelInput.focus(); return; }

    const type = typeSelect.value;
    const options = type === "dropdown"
        ? optionsInput.value.split("\n").map(s => s.trim()).filter(Boolean)
        : [];

    const { pageIndex, x, y, width, height, fieldId, overlay } = pdfPopoverState;

    if (fieldId) {
        const existing = editingFields.find(f => f.id === fieldId);
        if (existing) {
            existing.type = type;
            existing.label = label;
            existing.required = requiredInput.checked;
            existing.options = options;
        }
    } else {
        editingFields.push({
            id: makeFieldId(),
            type,
            label,
            required: requiredInput.checked,
            options,
            page: pageIndex,
            x, y, width, height
        });
    }

    renderFieldBoxesForPage(overlay, pageIndex);
    closePdfFieldPopover();
}

function handlePdfFieldDelete() {
    if (!pdfPopoverState?.fieldId) return;
    const { fieldId, overlay, pageIndex } = pdfPopoverState;
    editingFields = editingFields.filter(f => f.id !== fieldId);
    renderFieldBoxesForPage(overlay, pageIndex);
    closePdfFieldPopover();
}

/* ---------- builder modal: open/close/save/delete ---------- */

async function openFormBuilderModal(record) {
    editingFormRecord = record || null;
    editingFields = record && Array.isArray(record.fields)
        ? JSON.parse(JSON.stringify(record.fields))
        : [];

    pdfBuilderDoc = null;
    pdfBuilderBytes = null;
    pdfBuilderIsNewUpload = false;
    pdfBuilderPageCount = 0;
    closePdfFieldPopover();

    const titleEl = document.getElementById("formBuilderModalTitle");
    const subtitleEl = document.getElementById("formBuilderModalSubtitle");
    const idInput = document.getElementById("formIdInput");
    const titleInput = document.getElementById("formTitleInput");
    const descriptionInput = document.getElementById("formDescriptionInput");
    const messageEl = document.getElementById("formBuilderMessage");
    const saveBtn = document.getElementById("saveFormBtn");
    const deleteBtn = document.getElementById("deleteFormBtn");
    const legacySection = document.getElementById("formLegacyFieldsSection");
    const pdfSection = document.getElementById("formPdfBuilderSection");
    const popupEl = document.querySelector(".form-builder-popup");

    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    // Older forms built the manual way (no pdf_path) keep editing through
    // the legacy field list. Everything else — new forms, and existing
    // PDF-based forms — uses the PDF builder.
    const isLegacyEdit = Boolean(record && !record.pdf_path);

    if (legacySection) legacySection.style.display = isLegacyEdit ? "flex" : "none";
    if (pdfSection) pdfSection.style.display = isLegacyEdit ? "none" : "block";
    popupEl?.classList.toggle("form-builder-popup--pdf", !isLegacyEdit);

    // Reset the PDF upload UI to its empty state; loadExistingPdfIntoBuilder
    // (below) repopulates it if this form already has a source PDF.
    const uploadPrompt = document.getElementById("formPdfUploadPrompt");
    const workspace = document.getElementById("formPdfWorkspace");
    const pagesContainer = document.getElementById("formPdfPagesContainer");
    if (uploadPrompt) uploadPrompt.style.display = "block";
    if (workspace) workspace.style.display = "none";
    if (pagesContainer) pagesContainer.innerHTML = "";

    if (record) {
        if (titleEl) titleEl.textContent = "Edit Form";
        if (subtitleEl) {
            subtitleEl.textContent = isLegacyEdit
                ? "Update the form's questions, or delete it below."
                : "Add, edit, or remove fields on the document, or delete this form below.";
        }
        if (idInput) idInput.value = record.id;
        if (titleInput) titleInput.value = record.title || "";
        if (descriptionInput) descriptionInput.value = record.description || "";
        if (saveBtn) saveBtn.textContent = "Save changes";
        if (deleteBtn) deleteBtn.style.display = "block";
    } else {
        if (titleEl) titleEl.textContent = "New Form";
        if (subtitleEl) subtitleEl.textContent = "Upload the form's PDF, then click and drag on it to add fields.";
        if (idInput) idInput.value = "";
        if (titleInput) titleInput.value = "";
        if (descriptionInput) descriptionInput.value = "";
        if (saveBtn) saveBtn.textContent = "Create form";
        if (deleteBtn) deleteBtn.style.display = "none";
    }

    if (isLegacyEdit) renderFieldEditorList();

    document.getElementById("formBuilderModalOverlay")?.classList.remove("hidden");
    document.body.classList.add("popup-active");

    if (record && record.pdf_path) {
        await loadExistingPdfIntoBuilder(record.pdf_path);
    }
}

function closeFormBuilderModal() {
    document.getElementById("formBuilderModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
    editingFormRecord = null;
    editingFields = [];
    pdfBuilderDoc = null;
    pdfBuilderBytes = null;
    pdfBuilderIsNewUpload = false;
    pdfBuilderPageCount = 0;
    closePdfFieldPopover();
}

function setFormBuilderSaving(isSaving) {
    const btn = document.getElementById("saveFormBtn");
    if (!btn) return;
    const isEditing = Boolean(editingFormRecord);
    btn.disabled = isSaving;
    btn.textContent = isSaving ? "Saving…" : (isEditing ? "Save changes" : "Create form");
}

async function handleSaveForm(event) {
    event.preventDefault();

    const titleInput = document.getElementById("formTitleInput");
    const descriptionInput = document.getElementById("formDescriptionInput");
    const messageEl = document.getElementById("formBuilderMessage");

    const title = titleInput?.value.trim();
    const description = descriptionInput?.value.trim() || "";

    if (!title) {
        if (messageEl) { messageEl.textContent = "Give the form a title."; messageEl.className = "auth-message error"; }
        return;
    }

    if (!window.supabaseClient) {
        if (messageEl) { messageEl.textContent = "Couldn't connect to Supabase. Please refresh and try again."; messageEl.className = "auth-message error"; }
        return;
    }

    const isLegacyEdit = Boolean(editingFormRecord && !editingFormRecord.pdf_path);

    if (isLegacyEdit) {
        await saveLegacyForm(title, description, messageEl);
    } else {
        await savePdfForm(title, description, messageEl);
    }
}

async function saveLegacyForm(title, description, messageEl) {
    const cleanedFields = editingFields
        .map(f => ({ ...f, label: (f.label || "").trim() }))
        .filter(f => f.label);

    if (!cleanedFields.length) {
        if (messageEl) { messageEl.textContent = "Add at least one question with a label."; messageEl.className = "auth-message error"; }
        return;
    }

    setFormBuilderSaving(true);
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    try {
        const { data: updated, error } = await window.supabaseClient
            .from(FORM_TEMPLATES_TABLE)
            .update({ title, description, fields: cleanedFields, updated_at: new Date().toISOString() })
            .eq("id", editingFormRecord.id)
            .select()
            .single();

        if (error) throw error;

        replaceFormCard(updated);
        closeFormBuilderModal();
        showFormPageMessage(`"${title}" was updated.`, "success");
    } catch (error) {
        console.error("Failed to save form:", error);
        if (messageEl) { messageEl.textContent = "Something went wrong saving this form. Please try again."; messageEl.className = "auth-message error"; }
    } finally {
        setFormBuilderSaving(false);
    }
}

async function savePdfForm(title, description, messageEl) {
    if (!pdfBuilderDoc || !pdfBuilderBytes) {
        if (messageEl) { messageEl.textContent = "Upload a PDF for this form first."; messageEl.className = "auth-message error"; }
        return;
    }

    const cleanedFields = editingFields
        .map(f => ({ ...f, label: (f.label || "").trim() }))
        .filter(f => f.label);

    if (!cleanedFields.length) {
        if (messageEl) { messageEl.textContent = "Click and drag on the document to add at least one field."; messageEl.className = "auth-message error"; }
        return;
    }

    setFormBuilderSaving(true);
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    try {
        const isEditing = Boolean(editingFormRecord);
        const formId = isEditing ? editingFormRecord.id : crypto.randomUUID();
        const needsUpload = pdfBuilderIsNewUpload || !isEditing;
        let pdfPath = isEditing ? editingFormRecord.pdf_path : null;

        if (needsUpload) {
            pdfPath = `${formId}/source.pdf`;
            const { error: uploadError } = await window.supabaseClient
                .storage
                .from(FORM_TEMPLATE_SOURCES_BUCKET)
                .upload(pdfPath, new Blob([pdfBuilderBytes], { type: "application/pdf" }), {
                    cacheControl: "3600",
                    upsert: true,
                    contentType: "application/pdf"
                });
            if (uploadError) throw uploadError;
        }

        const payload = {
            title,
            description,
            fields: cleanedFields,
            pdf_path: pdfPath,
            page_count: pdfBuilderPageCount
        };

        if (isEditing) {
            const { data: updated, error } = await window.supabaseClient
                .from(FORM_TEMPLATES_TABLE)
                .update({ ...payload, updated_at: new Date().toISOString() })
                .eq("id", editingFormRecord.id)
                .select()
                .single();

            if (error) throw error;

            replaceFormCard(updated);
            closeFormBuilderModal();
            showFormPageMessage(`"${title}" was updated.`, "success");
        } else {
            const { data: inserted, error } = await window.supabaseClient
                .from(FORM_TEMPLATES_TABLE)
                .insert({
                    id: formId,
                    ...payload,
                    created_by: getFormStaffId(),
                    created_by_name: getFormStaffName()
                })
                .select()
                .single();

            if (error) throw error;

            prependFormCard(inserted);
            closeFormBuilderModal();
            showFormPageMessage(`"${title}" was created.`, "success");
        }
    } catch (error) {
        console.error("Failed to save form:", error);
        if (messageEl) { messageEl.textContent = "Something went wrong saving this form. Please try again."; messageEl.className = "auth-message error"; }
    } finally {
        setFormBuilderSaving(false);
    }
}

function openDeleteFormConfirm() {
    if (!editingFormRecord) return;
    const messageEl = document.getElementById("deleteFormConfirmMessage");
    if (messageEl) messageEl.textContent = "";
    document.getElementById("deleteFormConfirmOverlay")?.classList.remove("hidden");
}

function closeDeleteFormConfirm() {
    document.getElementById("deleteFormConfirmOverlay")?.classList.add("hidden");
}

async function confirmDeleteForm() {
    if (!editingFormRecord) return;
    const record = editingFormRecord;
    const confirmBtn = document.getElementById("confirmDeleteFormBtn");
    const messageEl = document.getElementById("deleteFormConfirmMessage");

    if (confirmBtn) confirmBtn.disabled = true;

    try {
        const { error } = await window.supabaseClient
            .from(FORM_TEMPLATES_TABLE)
            .delete()
            .eq("id", record.id);

        if (error) throw error;

        removeFormCardFromDom(record.id);
        closeDeleteFormConfirm();
        closeFormBuilderModal();
        showFormPageMessage(`"${record.title}" was deleted.`, "success");
    } catch (error) {
        console.error("Failed to delete form:", error);
        if (messageEl) messageEl.textContent = "Something went wrong deleting this form. Please try again.";
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

/* ---------- fill-out modal ---------- */

function renderFillField(field) {
    const isRequired = Boolean(field.required);
    const requiredMark = isRequired ? ` <span class="form-required-mark">*</span>` : "";

    if (field.type === "section") {
        return `<h3 class="form-section-heading">${formEscapeHtml(field.label)}</h3>`;
    }

    if (field.type === "paragraph") {
        return `
            <label class="auth-field" data-field-id="${field.id}">
                ${formEscapeHtml(field.label)}${requiredMark}
                <textarea rows="4" class="fill-field-input" data-field-id="${field.id}" data-field-type="${field.type}"></textarea>
            </label>
        `;
    }

    if (field.type === "dropdown") {
        const options = (field.options || []).map(o => `<option value="${formEscapeHtml(o)}">${formEscapeHtml(o)}</option>`).join("");
        return `
            <label class="auth-field" data-field-id="${field.id}">
                ${formEscapeHtml(field.label)}${requiredMark}
                <select class="fill-field-input" data-field-id="${field.id}" data-field-type="${field.type}">
                    <option value="">Select…</option>
                    ${options}
                </select>
            </label>
        `;
    }

    if (field.type === "checkboxes" || field.type === "radio") {
        const inputType = field.type === "radio" ? "radio" : "checkbox";
        const groupName = `${field.type}_${field.id}`;
        const options = (field.options || []).map(o => `
            <label class="form-check-option">
                <input type="${inputType}" name="${groupName}" value="${formEscapeHtml(o)}" class="fill-field-option-input" data-field-id="${field.id}" data-field-type="${field.type}">
                ${formEscapeHtml(o)}
            </label>
        `).join("");
        return `
            <div class="auth-field" data-field-id="${field.id}">
                ${formEscapeHtml(field.label)}${requiredMark}
                <div class="form-check-group">${options}</div>
            </div>
        `;
    }

    if (field.type === "date") {
        return `
            <label class="auth-field" data-field-id="${field.id}">
                ${formEscapeHtml(field.label)}${requiredMark}
                <input type="date" class="fill-field-input" data-field-id="${field.id}" data-field-type="${field.type}">
            </label>
        `;
    }

    if (field.type === "number") {
        return `
            <label class="auth-field" data-field-id="${field.id}">
                ${formEscapeHtml(field.label)}${requiredMark}
                <input type="number" class="fill-field-input" data-field-id="${field.id}" data-field-type="${field.type}">
            </label>
        `;
    }

    // short_text and anything unrecognized fall back to a plain text input.
    return `
        <label class="auth-field" data-field-id="${field.id}">
            ${formEscapeHtml(field.label)}${requiredMark}
            <input type="text" class="fill-field-input" data-field-id="${field.id}" data-field-type="${field.type}">
        </label>
    `;
}

async function openFillFormModal(record, existingSubmission) {
    fillFormRecord = record;
    fillPdfDoc = null;
    editingSubmission = existingSubmission || null;

    const titleEl = document.getElementById("fillFormTitle");
    const descriptionEl = document.getElementById("fillFormDescription");
    const legacyContainer = document.getElementById("fillFormFieldsContainer");
    const pdfContainer = document.getElementById("fillFormPdfContainer");
    const messageEl = document.getElementById("fillFormMessage");
    const submitBtn = document.getElementById("submitFillFormBtn");

    if (titleEl) titleEl.textContent = editingSubmission ? `Edit response — ${record.title}` : record.title;
    if (descriptionEl) descriptionEl.textContent = record.description || "";
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }
    if (submitBtn) submitBtn.textContent = editingSubmission ? "Save changes" : "Submit";

    document.getElementById("fillFormModalOverlay")?.classList.remove("hidden");
    document.body.classList.add("popup-active");

    if (record.pdf_path) {
        if (legacyContainer) { legacyContainer.style.display = "none"; legacyContainer.innerHTML = ""; }
        if (pdfContainer) {
            pdfContainer.style.display = "flex";
            pdfContainer.innerHTML = `<p class="workbook-preview-loading">Loading form…</p>`;
        }

        try {
            if (typeof pdfjsLib === "undefined") throw new Error("pdfjsLib not loaded");

            const { data, error } = await window.supabaseClient
                .storage
                .from(FORM_TEMPLATE_SOURCES_BUCKET)
                .download(record.pdf_path);
            if (error) throw error;

            const arrayBuffer = await data.arrayBuffer();
            fillPdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            await renderFillPdfPages(record);
            if (editingSubmission) applyExistingAnswers(record, editingSubmission.answers);
        } catch (error) {
            console.error("Failed to load form PDF:", error);
            if (pdfContainer) pdfContainer.innerHTML = `<p class="workbook-preview-empty">Couldn't load this form. Please try again.</p>`;
        }
    } else {
        if (pdfContainer) { pdfContainer.style.display = "none"; pdfContainer.innerHTML = ""; }
        if (legacyContainer) {
            legacyContainer.style.display = "block";
            legacyContainer.innerHTML = (record.fields || []).map(renderFillField).join("");
            if (editingSubmission) applyExistingAnswers(record, editingSubmission.answers);
        }
    }
}

// Pre-fills the just-rendered fill-out inputs (legacy generic-question
// inputs, or the real overlaid inputs on a PDF-based form) from a
// previously-submitted answers object — used when editing an existing
// response instead of starting a blank one. Dispatches a synthetic "input"
// event on PDF text/textarea inputs so their auto-fit font-size
// (wireAutoFitTextarea, wired at creation time against an empty value)
// recomputes for the pre-filled text instead of staying sized for "".
function applyExistingAnswers(record, answers) {
    if (!answers) return;
    const isPdfForm = Boolean(record.pdf_path);
    const container = document.getElementById(isPdfForm ? "fillFormPdfContainer" : "fillFormFieldsContainer");
    if (!container) return;

    (record.fields || []).forEach(field => {
        if (field.type === "section") return;
        const value = answers[field.id];
        if (value === undefined) return;

        if (isPdfForm) {
            const input = container.querySelector(`.pdf-fill-input[data-field-id="${field.id}"]`);
            if (!input) return;
            if (field.type === "checkbox") {
                input.checked = Boolean(value);
            } else {
                input.value = value;
                input.dispatchEvent(new Event("input", { bubbles: true }));
            }
            return;
        }

        if (field.type === "checkboxes") {
            const values = Array.isArray(value) ? value : [];
            container.querySelectorAll(`input[data-field-id="${field.id}"]`).forEach(el => {
                el.checked = values.includes(el.value);
            });
        } else if (field.type === "radio") {
            container.querySelectorAll(`input[data-field-id="${field.id}"]`).forEach(el => {
                el.checked = el.value === value;
            });
        } else {
            const input = container.querySelector(`.fill-field-input[data-field-id="${field.id}"]`);
            if (input) input.value = value;
        }
    });
}

async function renderFillPdfPages(record) {
    const container = document.getElementById("fillFormPdfContainer");
    if (!container || !fillPdfDoc) return;
    container.innerHTML = "";

    const fieldsByPage = {};
    (record.fields || []).forEach(f => {
        if (typeof f.page !== "number") return;
        (fieldsByPage[f.page] = fieldsByPage[f.page] || []).push(f);
    });

    for (let pageNum = 1; pageNum <= fillPdfDoc.numPages; pageNum++) {
        const pageIndex = pageNum - 1;
        const page = await fillPdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });

        const pageWrap = document.createElement("div");
        pageWrap.className = "pdf-page";
        // Only width is set inline — height is left to flow from the canvas
        // (which preserves its own aspect ratio via CSS), so the whole page
        // scales down responsively if the popup is narrower than the PDF's
        // native render width (see .pdf-page / .pdf-page-canvas in styles.css).
        pageWrap.style.width = `${viewport.width}px`;

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.className = "pdf-page-canvas";

        const overlay = document.createElement("div");
        overlay.className = "pdf-page-overlay pdf-page-overlay--fill";

        pageWrap.appendChild(canvas);
        pageWrap.appendChild(overlay);
        container.appendChild(pageWrap);

        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

        (fieldsByPage[pageIndex] || []).forEach(field => {
            overlay.appendChild(buildFillPdfFieldInput(field, viewport));
        });
    }
}

function buildFillPdfFieldInput(field, viewport) {
    const wrap = document.createElement("div");
    wrap.className = "pdf-fill-field";
    wrap.style.left = `${field.x * 100}%`;
    wrap.style.top = `${field.y * 100}%`;
    wrap.style.width = `${field.width * 100}%`;
    wrap.style.height = `${field.height * 100}%`;
    if (field.label) wrap.title = field.label;

    // Pixel box size (from the fraction stored on the field + this page's
    // rendered viewport) — used to size the auto-fit textareas below.
    // Percentage-based CSS sizing alone isn't enough for that since it
    // requires a layout pass to resolve; this is known immediately.
    const boxWidthPx = field.width * viewport.width;
    const boxHeightPx = field.height * viewport.height;

    let inputEl;
    if (field.type === "checkbox") {
        inputEl = document.createElement("input");
        inputEl.type = "checkbox";
        inputEl.className = "pdf-fill-input pdf-fill-input--checkbox";
    } else if (field.type === "dropdown") {
        inputEl = document.createElement("select");
        inputEl.className = "pdf-fill-input";
        inputEl.innerHTML = `<option value="">Select…</option>` +
            (field.options || []).map(o => `<option value="${formEscapeHtml(o)}">${formEscapeHtml(o)}</option>`).join("");
    } else if (field.type === "date") {
        inputEl = document.createElement("input");
        inputEl.type = "date";
        inputEl.className = "pdf-fill-input";
    } else if (field.type === "number") {
        inputEl = document.createElement("input");
        inputEl.type = "number";
        inputEl.className = "pdf-fill-input";
    } else if (field.type === "signature") {
        // Textarea (not input) so long typed answers can wrap instead of
        // scrolling out of view — auto-fit shrinks the font to match.
        inputEl = document.createElement("textarea");
        inputEl.rows = 1;
        inputEl.placeholder = "Type your name";
        inputEl.className = "pdf-fill-input pdf-fill-input--signature";
        wireAutoFitTextarea(inputEl, boxWidthPx, boxHeightPx, AUTO_FIT_SIGNATURE_FONT_FAMILY);
    } else {
        inputEl = document.createElement("textarea");
        inputEl.rows = 1;
        inputEl.className = "pdf-fill-input";
        wireAutoFitTextarea(inputEl, boxWidthPx, boxHeightPx, AUTO_FIT_TEXT_FONT_FAMILY);
    }

    inputEl.dataset.fieldId = field.id;
    inputEl.dataset.fieldType = field.type;

    wrap.appendChild(inputEl);
    return wrap;
}

function closeFillFormModal() {
    const wasEditingResponse = Boolean(editingSubmission);

    document.getElementById("fillFormModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
    fillFormRecord = null;
    fillPdfDoc = null;
    editingSubmission = null;

    // Editing a response opens on top of the Responses modal (see
    // openEditSubmissionModal), which is only *hidden* rather than fully
    // closed/reset for the duration — reveal it again here (refetching so a
    // saved edit's new answers/timestamp show immediately; unchanged on
    // Cancel) whether this close was a save, a Cancel, the ✕, or a
    // click-outside, since all four paths route through this function.
    if (wasEditingResponse && responsesFormRecord) {
        openResponsesModal(responsesFormRecord);
    }
}

// Reads the currently-rendered fill-out inputs back into { fieldId: value }.
// Returns { ok: false, missingLabel } if a required field was left blank.
function collectFillAnswers(record) {
    const container = document.getElementById("fillFormFieldsContainer");
    const answers = {};

    for (const field of record.fields || []) {
        if (field.type === "section") continue;

        let value;
        if (field.type === "checkboxes") {
            value = Array.from(container.querySelectorAll(`input[data-field-id="${field.id}"]:checked`)).map(el => el.value);
        } else if (field.type === "radio") {
            const checked = container.querySelector(`input[data-field-id="${field.id}"]:checked`);
            value = checked ? checked.value : "";
        } else {
            const input = container.querySelector(`.fill-field-input[data-field-id="${field.id}"]`);
            value = input ? input.value.trim() : "";
        }

        const isBlank = Array.isArray(value) ? value.length === 0 : !value;
        if (field.required && isBlank) {
            return { ok: false, missingLabel: field.label };
        }

        answers[field.id] = value;
    }

    return { ok: true, answers };
}

// Same contract as collectFillAnswers, but reads the overlaid real inputs
// used for PDF-based forms instead of the generic-question inputs.
function collectFillPdfAnswers(record) {
    const container = document.getElementById("fillFormPdfContainer");
    const answers = {};

    for (const field of record.fields || []) {
        if (typeof field.page !== "number") continue;
        const input = container?.querySelector(`.pdf-fill-input[data-field-id="${field.id}"]`);
        if (!input) continue;

        const value = field.type === "checkbox" ? input.checked : input.value.trim();
        const isBlank = field.type === "checkbox" ? !value : !value;

        if (field.required && isBlank) {
            return { ok: false, missingLabel: field.label };
        }

        answers[field.id] = value;
    }

    return { ok: true, answers };
}

function buildSubmissionPdfDocDefinition(record, answers, footerText) {
    const content = [
        { text: record.title, bold: true, fontSize: 18, margin: [0, 0, 0, 4] }
    ];

    if (record.description) {
        content.push({ text: record.description, italics: true, color: "#555555", margin: [0, 0, 0, 10] });
    }

    content.push({
        text: footerText,
        fontSize: 10, color: "#777777", margin: [0, 0, 0, 16]
    });

    (record.fields || []).forEach(field => {
        if (field.type === "section") {
            content.push({ text: field.label, bold: true, fontSize: 13, margin: [0, 14, 0, 6] });
            return;
        }
        const value = answers[field.id];
        const displayValue = Array.isArray(value)
            ? (value.length ? value.join(", ") : "—")
            : (value || "—");

        content.push({ text: field.label, bold: true, fontSize: 11, margin: [0, 8, 0, 2] });
        content.push({ text: String(displayValue), fontSize: 11 });
    });

    return {
        pageMargins: [50, 50, 50, 50],
        defaultStyle: { fontSize: 11 },
        content
    };
}

/* ===========================================================
   TEXT AUTO-FIT — shared by the live fill-out textareas (below) and the
   final generated PDF (buildPdfSubmissionBlob). Same greedy-wrap-then-
   shrink algorithm in both places; only how text width gets *measured*
   differs (canvas 2D for the live DOM view, pdf-lib's font metrics for
   the PDF), since a passed-in measureFn is all wrapTextGreedy needs.
=========================================================== */

// Greedy word-wrap: packs words onto a line until the next word would
// push it past maxWidth, then starts a new line. A single word wider than
// maxWidth on its own (long email, URL, etc.) gets hard-broken character
// by character so it still wraps instead of overflowing sideways.
function wrapTextGreedy(text, maxWidth, measureFn, fontSize) {
    const words = String(text).split(/\s+/).filter(Boolean);
    if (!words.length) return [""];

    const lines = [];
    let current = "";

    const breakLongWord = (word) => {
        let chunk = "";
        for (const char of word) {
            const test = chunk + char;
            if (chunk && measureFn(test, fontSize) > maxWidth) {
                lines.push(chunk);
                chunk = char;
            } else {
                chunk = test;
            }
        }
        current = chunk;
    };

    words.forEach(word => {
        const test = current ? `${current} ${word}` : word;
        if (measureFn(test, fontSize) <= maxWidth) {
            current = test;
            return;
        }
        if (current) { lines.push(current); current = ""; }
        if (measureFn(word, fontSize) <= maxWidth) {
            current = word;
        } else {
            breakLongWord(word);
        }
    });

    if (current) lines.push(current);
    return lines.length ? lines : [""];
}

// Shrinks fontSize from maxFontSize down to minFontSize (half-point steps)
// looking for the largest size whose wrapped lines fit within maxHeight.
// If even minFontSize doesn't fit everything, truncates to however many
// lines DO fit and ellipsizes the last one — so an answer that's just too
// long for its box gets cut off cleanly instead of spilling out of it.
function computeAutoFitText({ text, maxWidth, maxHeight, maxFontSize, minFontSize, lineHeightRatio, measureFn }) {
    const safeMaxWidth = Math.max(maxWidth, 4);
    const safeMaxHeight = Math.max(maxHeight, lineHeightRatio * minFontSize);

    for (let size = maxFontSize; size >= minFontSize; size -= 0.5) {
        const lines = wrapTextGreedy(text, safeMaxWidth, measureFn, size);
        if (lines.length * size * lineHeightRatio <= safeMaxHeight) {
            return { fontSize: size, lines, truncated: false };
        }
    }

    const size = minFontSize;
    const lines = wrapTextGreedy(text, safeMaxWidth, measureFn, size);
    const maxLines = Math.max(1, Math.floor(safeMaxHeight / (size * lineHeightRatio)));

    if (lines.length <= maxLines) {
        return { fontSize: size, lines, truncated: false };
    }

    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && measureFn(`${last}…`, size) > safeMaxWidth) {
        last = last.slice(0, -1);
    }
    kept[maxLines - 1] = `${last.replace(/\s+$/, "")}…`;

    return { fontSize: size, lines: kept, truncated: true };
}

// Offscreen canvas reused for every live-preview measurement — cheaper
// than creating one per field/keystroke.
const autoFitMeasureCtx = document.createElement("canvas").getContext("2d");
const AUTO_FIT_TEXT_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const AUTO_FIT_SIGNATURE_FONT_FAMILY = '"Brush Script MT", cursive';

function measureDomTextWidth(text, fontSizePx, fontFamily) {
    autoFitMeasureCtx.font = `${fontSizePx}px ${fontFamily}`;
    return autoFitMeasureCtx.measureText(text).width;
}

// Wires a textarea so its font-size shrinks (and wraps) live as the person
// types, matching the same fit logic used when the final PDF is generated.
function wireAutoFitTextarea(textarea, boxWidthPx, boxHeightPx, fontFamily) {
    const padding = 4;
    const lineHeightRatio = 1.2;
    const maxFontSize = Math.max(9, Math.min(boxHeightPx * 0.55, 15));
    const minFontSize = 8;

    const recompute = () => {
        const text = textarea.value || textarea.placeholder || " ";
        const { fontSize } = computeAutoFitText({
            text,
            maxWidth: Math.max(boxWidthPx - padding * 2, 6),
            maxHeight: Math.max(boxHeightPx - padding, lineHeightRatio * minFontSize),
            maxFontSize,
            minFontSize,
            lineHeightRatio,
            measureFn: (str, size) => measureDomTextWidth(str, size, fontFamily)
        });
        textarea.style.fontSize = `${fontSize}px`;
        textarea.style.lineHeight = String(lineHeightRatio);
    };

    textarea.addEventListener("input", recompute);
    recompute();
}

// Draws the submitted answers directly onto the source PDF's pages (at each
// field's stored page/x/y/width/height) and flattens to a new PDF — so the
// output looks like the real form, filled in, instead of a freshly
// generated document.
async function buildPdfSubmissionBlob(record, answers) {
    const { data, error } = await window.supabaseClient
        .storage
        .from(FORM_TEMPLATE_SOURCES_BUCKET)
        .download(record.pdf_path);
    if (error) throw error;

    const templateBytes = await data.arrayBuffer();
    const pdfDoc = await PDFLib.PDFDocument.load(templateBytes);
    const helvetica = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    const helveticaOblique = await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaOblique);
    const pages = pdfDoc.getPages();

    (record.fields || []).forEach(field => {
        if (typeof field.page !== "number") return;
        const page = pages[field.page];
        if (!page) return;

        const value = answers[field.id];
        const { width: pageWidth, height: pageHeight } = page.getSize();

        const boxX = field.x * pageWidth;
        const boxTopY = pageHeight - field.y * pageHeight; // PDF y-axis is bottom-up; field.y is measured from the top
        const boxWidth = field.width * pageWidth;
        const boxHeight = field.height * pageHeight;

        if (field.type === "checkbox") {
            if (!value) return;
            const fontSize = Math.max(9, Math.min(boxHeight * 0.75, 14));
            page.drawText("X", {
                x: boxX + boxWidth * 0.25,
                y: boxTopY - boxHeight * 0.8,
                size: fontSize,
                font: helvetica,
                color: PDFLib.rgb(0.1, 0.1, 0.1)
            });
            return;
        }

        const text = Array.isArray(value) ? value.join(", ") : String(value || "").trim();
        if (!text) return;

        const font = field.type === "signature" ? helveticaOblique : helvetica;
        const padding = 2;
        const lineHeightRatio = 1.15;
        const minFontSize = 5;
        const maxFontSize = Math.max(minFontSize, Math.min(boxHeight * 0.6, 12));

        // Auto-fit: shrinks (and wraps if needed) so the answer stays
        // inside the drawn box instead of overflowing it.
        const { fontSize, lines } = computeAutoFitText({
            text,
            maxWidth: Math.max(boxWidth - padding * 2, 6),
            maxHeight: Math.max(boxHeight - padding, lineHeightRatio * minFontSize),
            maxFontSize,
            minFontSize,
            lineHeightRatio,
            measureFn: (str, size) => font.widthOfTextAtSize(str, size)
        });

        let lineY = boxTopY - padding - fontSize;
        lines.forEach(line => {
            page.drawText(line, {
                x: boxX + padding,
                y: lineY,
                size: fontSize,
                font,
                color: PDFLib.rgb(0.05, 0.05, 0.45)
            });
            lineY -= fontSize * lineHeightRatio;
        });
    });

    const finalBytes = await pdfDoc.save();
    return new Blob([finalBytes], { type: "application/pdf" });
}

async function handleSubmitFillForm(event) {
    event.preventDefault();
    if (!fillFormRecord) return;

    const record = fillFormRecord;
    const isEditing = Boolean(editingSubmission);
    const messageEl = document.getElementById("fillFormMessage");
    const submitBtn = document.getElementById("submitFillFormBtn");
    const isPdfForm = Boolean(record.pdf_path);

    const result = isPdfForm ? collectFillPdfAnswers(record) : collectFillAnswers(record);
    if (!result.ok) {
        if (messageEl) {
            messageEl.textContent = `Please answer "${result.missingLabel}" before submitting.`;
            messageEl.className = "auth-message error";
        }
        return;
    }

    if (!isPdfForm && typeof pdfMake === "undefined") {
        if (messageEl) {
            messageEl.textContent = "The PDF library failed to load. Refresh and try again.";
            messageEl.className = "auth-message error";
        }
        return;
    }

    if (isPdfForm && typeof PDFLib === "undefined") {
        if (messageEl) {
            messageEl.textContent = "The PDF library failed to load. Refresh and try again.";
            messageEl.className = "auth-message error";
        }
        return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = isEditing ? "Saving…" : "Submitting…"; }
    if (messageEl) { messageEl.textContent = isEditing ? "Saving…" : "Submitting…"; messageEl.className = "auth-message"; }

    const submittedByName = isEditing ? (editingSubmission.submitted_by_name || "Staff") : getFormStaffName();
    const submittedById = isEditing ? editingSubmission.submitted_by : getFormStaffId();

    // On an edit, the generated PDF's footer keeps crediting the original
    // submitter/date and adds who edited it and when — it doesn't rewrite
    // history to look like a fresh submission just because the file got
    // regenerated.
    const footerText = isEditing
        ? `Submitted by ${submittedByName} on ${new Date(editingSubmission.created_at).toLocaleString()} • Edited by ${getFormStaffName()} on ${new Date().toLocaleString()}`
        : `Submitted by ${submittedByName} on ${new Date().toLocaleString()}`;

    try {
        const blob = isPdfForm
            ? await buildPdfSubmissionBlob(record, result.answers)
            : await pdfMake.createPdf(buildSubmissionPdfDocDefinition(record, result.answers, footerText)).getBlob();

        if (isEditing) {
            const submissionId = editingSubmission.id;
            const pdfPath = editingSubmission.pdf_path || `${record.id}/${submissionId}.pdf`;

            // Overwrite the file at its existing storage path (upsert: true)
            // — this is a deliberate replace of that one submission's PDF,
            // not a new record, so it keeps its original id/path rather than
            // getting a fresh one the way a brand-new submission does below.
            const { error: uploadError } = await window.supabaseClient
                .storage
                .from(FORM_SUBMISSIONS_BUCKET)
                .upload(pdfPath, blob, { cacheControl: "3600", upsert: true, contentType: "application/pdf" });
            if (uploadError) throw uploadError;

            const { error: updateError } = await window.supabaseClient
                .from(FORM_SUBMISSIONS_TABLE)
                .update({
                    answers: result.answers,
                    pdf_path: pdfPath,
                    edited_at: new Date().toISOString(),
                    edited_by: getFormStaffId(),
                    edited_by_name: getFormStaffName()
                })
                .eq("id", submissionId);
            if (updateError) throw updateError;

            closeFillFormModal(); // also re-opens the Responses modal this edit was opened from, refreshed
            showFormPageMessage(`Response updated.`, "success");
        } else {
            const submissionId = crypto.randomUUID();
            const pdfPath = `${record.id}/${submissionId}.pdf`;

            const { error: uploadError } = await window.supabaseClient
                .storage
                .from(FORM_SUBMISSIONS_BUCKET)
                .upload(pdfPath, blob, { cacheControl: "3600", upsert: false, contentType: "application/pdf" });
            if (uploadError) throw uploadError;

            const { error: insertError } = await window.supabaseClient
                .from(FORM_SUBMISSIONS_TABLE)
                .insert({
                    id: submissionId,
                    form_id: record.id,
                    form_title: record.title,
                    submitted_by: submittedById,
                    submitted_by_name: submittedByName,
                    answers: result.answers,
                    pdf_path: pdfPath
                });
            if (insertError) throw insertError;

            if (submittedById) {
                await window.supabaseClient.from("notifications").insert({
                    user_id: submittedById,
                    title: "Form submitted",
                    message: `Your "${record.title}" form has been submitted.`,
                    type: "form_submission",
                    link_url: `form-template.html?viewSubmission=${submissionId}`,
                    link_label: "View it here"
                });
            }

            closeFillFormModal();
            showFormPageMessage(`Thanks — "${record.title}" was submitted.`, "success");
        }
    } catch (error) {
        console.error(isEditing ? "Failed to save response:" : "Failed to submit form:", error);
        if (messageEl) {
            messageEl.textContent = "Something went wrong. Please try again.";
            messageEl.className = "auth-message error";
        }
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEditing ? "Save changes" : "Submit"; }
    }
}

/* ---------- responses modal ---------- */

async function openResponsesModal(record) {
    responsesFormRecord = record;

    const titleEl = document.getElementById("formResponsesTitle");
    const listEl = document.getElementById("formResponsesList");
    if (titleEl) titleEl.textContent = `Responses — ${record.title}`;
    if (listEl) listEl.innerHTML = `<p class="workbook-preview-loading">Loading responses…</p>`;

    document.getElementById("formResponsesModalOverlay")?.classList.remove("hidden");
    document.body.classList.add("popup-active");

    const { data, error } = await window.supabaseClient
        .from(FORM_SUBMISSIONS_TABLE)
        .select("*")
        .eq("form_id", record.id)
        .order("created_at", { ascending: false });

    if (error) {
        console.error("Failed to load responses:", error);
        if (listEl) listEl.innerHTML = `<p class="workbook-preview-empty">Couldn't load responses. Please try again.</p>`;
        return;
    }

    if (!data || !data.length) {
        if (listEl) listEl.innerHTML = `<p class="workbook-preview-empty">No responses yet.</p>`;
        return;
    }

    if (listEl) {
        listEl.innerHTML = "";
        data.forEach(submission => {
            const editedNote = submission.edited_at
                ? `<p class="workbook-preview-loading" style="margin:0;">Edited ${formEscapeHtml(formatFormDate(submission.edited_at))}${submission.edited_by_name ? ` by ${formEscapeHtml(submission.edited_by_name)}` : ""}</p>`
                : "";
            const row = document.createElement("div");
            row.className = "notification-item";
            row.innerHTML = `
                <strong>${formEscapeHtml(submission.submitted_by_name || "Staff")}</strong>
                <p>${formEscapeHtml(formatFormDate(submission.created_at))}</p>
                ${editedNote}
            `;
            const actionsWrap = document.createElement("div");
            actionsWrap.style.display = "flex";
            actionsWrap.style.gap = "8px";
            actionsWrap.style.marginTop = "8px";

            const viewBtn = document.createElement("button");
            viewBtn.type = "button";
            viewBtn.className = "workbook-btn workbook-btn--preview";
            viewBtn.textContent = "View PDF";
            viewBtn.addEventListener("click", () => viewFormSubmission(submission));

            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "workbook-btn workbook-btn--edit";
            editBtn.textContent = "Edit";
            editBtn.addEventListener("click", () => openEditSubmissionModal(record, submission));

            actionsWrap.appendChild(viewBtn);
            actionsWrap.appendChild(editBtn);
            row.appendChild(actionsWrap);
            listEl.appendChild(row);
        });
    }
}

// Opens the fill-out modal (in edit mode) for an existing response. It
// reuses #fillFormModalOverlay rather than a separate modal, but that
// element sits *earlier* in form-template.html's DOM order than
// #formResponsesModalOverlay it's opening from — unlike the submission-PDF
// preview modal (which comes later and so naturally paints on top when both
// are visible), simply revealing it wouldn't paint over the Responses list
// behind it. Hiding (not fully closing — responsesFormRecord stays set) the
// Responses modal here sidesteps that; closeFillFormModal() reveals it again
// once the edit is done, saved or not.
function openEditSubmissionModal(record, submission) {
    document.getElementById("formResponsesModalOverlay")?.classList.add("hidden");
    openFillFormModal(record, submission);
}

function closeResponsesModal() {
    document.getElementById("formResponsesModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
    responsesFormRecord = null;
}

/* ---------- submission PDF preview (signed URL, bucket is private) ---------- */

async function viewFormSubmission(submission) {
    if (!submission?.pdf_path) return;

    const overlay = document.getElementById("submissionPreviewModalOverlay");
    const titleEl = document.getElementById("submissionPreviewTitle");
    const container = document.getElementById("submissionPreviewContainer");
    const messageEl = document.getElementById("submissionPreviewMessage");

    if (titleEl) titleEl.textContent = submission.form_title || "Form submission";
    if (container) container.innerHTML = "";
    if (messageEl) { messageEl.textContent = "Loading…"; messageEl.style.display = "block"; }

    overlay?.classList.remove("hidden");
    document.body.classList.add("popup-active");

    const { data, error } = await window.supabaseClient
        .storage
        .from(FORM_SUBMISSIONS_BUCKET)
        .createSignedUrl(submission.pdf_path, 60 * 10); // 10 minute link

    if (error || !data?.signedUrl) {
        console.error("Failed to create signed URL for submission PDF:", error);
        if (messageEl) { messageEl.textContent = "Couldn't open this submission. Please try again."; messageEl.style.display = "block"; }
        return;
    }

    if (messageEl) messageEl.style.display = "none";
    if (container) {
        const iframe = document.createElement("iframe");
        iframe.src = data.signedUrl;
        iframe.title = "Submission preview";
        container.appendChild(iframe);
    }
}

function closeSubmissionPreviewModal() {
    document.getElementById("submissionPreviewModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
    const container = document.getElementById("submissionPreviewContainer");
    if (container) container.innerHTML = "";
}

// If we landed here from a notification's "View it here" link
// (form-template.html?viewSubmission=<id>), open that submission directly.
async function checkForSubmissionLinkParam() {
    const submissionId = new URLSearchParams(window.location.search).get("viewSubmission");
    if (!submissionId || !window.supabaseClient) return;

    const { data, error } = await window.supabaseClient
        .from(FORM_SUBMISSIONS_TABLE)
        .select("*")
        .eq("id", submissionId)
        .maybeSingle();

    if (error || !data) {
        console.error("Failed to load linked submission:", error);
        return;
    }

    viewFormSubmission(data);
}

/* ---------- search ---------- */

function initFormSearch() {
    const searchInput = document.getElementById("formSearchInput");
    const grid = document.getElementById("formGrid");
    const noResultsState = document.getElementById("formNoResultsState");

    if (!searchInput || !grid) return;

    function applyFilter() {
        const query = searchInput.value.trim().toLowerCase();
        const cards = Array.from(grid.children);
        let visibleCount = 0;

        cards.forEach(card => {
            const matches = !query || card.textContent.toLowerCase().includes(query);
            card.style.display = matches ? "" : "none";
            if (matches) visibleCount++;
        });

        if (noResultsState) {
            noResultsState.style.display = (cards.length > 0 && query && visibleCount === 0) ? "block" : "none";
        }
    }

    searchInput.addEventListener("input", applyFilter);
    new MutationObserver(applyFilter).observe(grid, { childList: true });
}

/* ---------- wire up ---------- */

window.addEventListener("DOMContentLoaded", function () {
    loadFormTemplates().then(checkForSubmissionLinkParam);
    initFormSearch();

    const newFormBtn = document.getElementById("newFormBtn");
    if (newFormBtn) {
        newFormBtn.style.display = canManageForms() ? "inline-flex" : "none";
        newFormBtn.addEventListener("click", () => openFormBuilderModal(null));
    }

    document.getElementById("cancelFormBtn")?.addEventListener("click", closeFormBuilderModal);
    document.getElementById("formBuilderForm")?.addEventListener("submit", handleSaveForm);
    document.getElementById("deleteFormBtn")?.addEventListener("click", openDeleteFormConfirm);
    document.getElementById("cancelDeleteFormBtn")?.addEventListener("click", closeDeleteFormConfirm);
    document.getElementById("confirmDeleteFormBtn")?.addEventListener("click", confirmDeleteForm);

    const addFieldBtn = document.getElementById("addFieldBtn");
    const addFieldTypeSelect = document.getElementById("addFieldTypeSelect");
    if (addFieldBtn && addFieldTypeSelect) {
        if (!addFieldTypeSelect.options.length) {
            addFieldTypeSelect.innerHTML = FORM_FIELD_TYPES
                .map(t => `<option value="${t.value}">${formEscapeHtml(t.label)}</option>`)
                .join("");
        }
        addFieldBtn.addEventListener("click", () => addFieldOfType(addFieldTypeSelect.value));
    }

    document.getElementById("formPdfFileInput")?.addEventListener("change", handlePdfFileSelected);
    document.getElementById("pdfFieldTypeSelect")?.addEventListener("change", (e) => {
        const optionsWrap = document.getElementById("pdfFieldOptionsWrap");
        if (optionsWrap) optionsWrap.style.display = e.target.value === "dropdown" ? "block" : "none";
    });
    document.getElementById("pdfFieldSaveBtn")?.addEventListener("click", handlePdfFieldSave);
    document.getElementById("pdfFieldDeleteBtn")?.addEventListener("click", handlePdfFieldDelete);
    document.getElementById("pdfFieldCancelBtn")?.addEventListener("click", closePdfFieldPopover);

    document.getElementById("cancelFillFormBtn")?.addEventListener("click", closeFillFormModal);
    document.getElementById("fillForm")?.addEventListener("submit", handleSubmitFillForm);

    document.getElementById("closeFormResponsesBtn")?.addEventListener("click", closeResponsesModal);
    document.getElementById("closeSubmissionPreviewBtn")?.addEventListener("click", closeSubmissionPreviewModal);

    document.getElementById("formBuilderModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeFormBuilderModal();
    });
    document.getElementById("fillFormModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeFillFormModal();
    });
    document.getElementById("formResponsesModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeResponsesModal();
    });
    document.getElementById("submissionPreviewModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeSubmissionPreviewModal();
    });
    document.getElementById("deleteFormConfirmOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeDeleteFormConfirm();
    });
});
