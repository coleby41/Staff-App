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

// Session freshness gate for this file's higher-stakes writes (submitting a
// form, deleting one). supabase-js's own background auto-refresh runs on a
// timer that browsers throttle heavily for a backgrounded/idle tab, so on a
// long-lived page — someone spends 20 minutes filling out a form, or leaves
// the tab open — the in-memory access token can sit quietly expired well
// before that timer ever fires, and the very first write after that goes out
// with a stale/missing token. Different Supabase services react differently
// to that: a plain REST call (e.g. deleting a form) gets a flat 401 from
// Supabase Auth's own JWT check; a storage/table write whose bearer token
// silently dropped out gets treated as anonymous and blocked by RLS instead,
// which surfaces as "new row violates row-level security policy" — a
// confusing, data-sounding error for what's really just a stale login.
// Calling this right before a write forces a check (and refresh, if needed)
// so the request that follows carries a genuinely current token, instead of
// finding out only after the write already failed.
async function ensureFreshSupabaseSession() {
    try {
        const { data, error } = await window.supabaseClient.auth.getSession();
        if (error || !data?.session) return false;

        // expires_at is unix seconds; refresh proactively inside the last
        // minute rather than waiting to actually hit the wall.
        const expiresAt = data.session.expires_at;
        const isStaleOrExpiring = !expiresAt || (expiresAt * 1000) < (Date.now() + 60000);
        if (!isStaleOrExpiring) return true;

        const { data: refreshed, error: refreshError } = await window.supabaseClient.auth.refreshSession();
        return Boolean(!refreshError && refreshed?.session);
    } catch (err) {
        console.warn("ensureFreshSupabaseSession: couldn't verify/refresh session", err);
        return false;
    }
}

// True when a caught error looks like the request went out without a valid
// session (see ensureFreshSupabaseSession above) rather than an actual data
// problem — so the person gets told to sign back in instead of a generic
// "try again" that will just fail the exact same way every time.
function isAuthSessionError(error) {
    const status = error?.status ?? error?.statusCode;
    const message = String(error?.message || "");
    return status === 401 || status === "401"
        || /row-level security policy/i.test(message)
        || /jwt/i.test(message);
}

const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please refresh the page and sign in again.";

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
let responsesCurrentSubmissions = []; // the Responses modal's currently-loaded rows, for "Download All"
let submissionPendingDelete = null; // { record, submission } queued up in the delete-confirm popup, or null
let pendingSubmission = null;   // validated answers/blob-inputs waiting on a file name from the "Name this file" popup, between handleSubmitFillForm() and handleConfirmSubmissionFileName()
let previewingSubmission = null; // the form_submissions row currently shown in the PDF preview modal, so its Download button knows what to fetch

// All Files project-filing state (see project-files.html for the other
// side of this). Both nullable/empty by default — every existing form
// keeps working exactly as before unless a template sets a folder mapping.
let projectIdFromUrl = null;      // ?project=<id> — set when we got here from a project's All Files page
let templateIdFromUrl = null;     // ?template=<id> — auto-opens that template's fill modal on load
let projectsForPicker = [];       // [{id, name}] the current user is a member of, loaded lazily for the name-submission-file project <select>
let projectsForPickerLoaded = false;

// PDF builder state (form-template.html "New Form" / editing a PDF-based form)
let pdfBuilderDoc = null;         // pdf.js PDFDocumentProxy currently loaded in the builder
let pdfBuilderBytes = null;       // ArrayBuffer copy of that PDF, kept for upload (pdf.js consumes its own copy)
let pdfBuilderIsNewUpload = false; // true if pdfBuilderBytes came from a file picked this session (vs. an existing form's stored PDF)
let pdfBuilderPageCount = 0;
let pdfPopoverState = null;       // { pageIndex, overlay, x, y, width, height, fieldId } for the field currently being added/edited

// PDF fill-out state (form-template.html fill-out modal)
let fillPdfDoc = null; // pdf.js PDFDocumentProxy currently loaded in the fill-out modal

// Per-submission PDF attachments (only shown when fillFormRecord.allow_attachments
// is on). Each entry is { id, name, file, path }: a newly-added attachment
// has `file` (a File, not yet uploaded) and `path: null`; an existing
// attachment loaded from an in-progress edit has `path` (already in
// storage) and `file: null`. Order in this array is the merge order.
let fillFormAttachments = [];
let fillFormAttachmentDragId = null; // id of the attachment row currently being dragged, between dragstart and drop

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

/* ---------- All Files folder mapping (form_templates.default_category/subfolder/project_id) ---------- */

// Populates the category select once, the subfolder select for whichever
// category is currently chosen, and the project-lock select (disabled until
// a category is picked, same as subfolder). Called on modal open and again
// whenever the category select changes; async because the project list is
// loaded lazily, same as the fill-out project picker.
async function renderFileFolderPicker(selectedCategory, selectedSubfolder, selectedProjectId) {
    const categorySelect = document.getElementById("formFileCategorySelect");
    const subfolderSelect = document.getElementById("formFileSubfolderSelect");
    if (!categorySelect || !subfolderSelect) return;

    const categories = (window.ProjectFields && window.ProjectFields.PROJECT_FILE_CATEGORIES) || [];

    categorySelect.innerHTML = `<option value="">No filing (org-wide form)</option>` +
        categories.map(c => `<option value="${formEscapeHtml(c.key)}">${formEscapeHtml(c.number)} — ${formEscapeHtml(c.label)}</option>`).join("");
    categorySelect.value = selectedCategory || "";

    renderFileSubfolderOptions(selectedCategory, selectedSubfolder);
    await renderFileProjectLockOptions(selectedCategory, selectedProjectId);
}

function renderFileSubfolderOptions(categoryKey, selectedSubfolder) {
    const subfolderSelect = document.getElementById("formFileSubfolderSelect");
    if (!subfolderSelect) return;

    const category = categoryKey && window.ProjectFields ? window.ProjectFields.findFileCategory(categoryKey) : null;

    if (!category) {
        subfolderSelect.innerHTML = `<option value="">—</option>`;
        subfolderSelect.disabled = true;
        subfolderSelect.value = "";
        return;
    }

    subfolderSelect.disabled = false;
    subfolderSelect.innerHTML = `<option value="">Choose a subfolder…</option>` +
        category.subfolders.map(s => `<option value="${formEscapeHtml(s.key)}">${formEscapeHtml(s.label)}</option>`).join("");
    subfolderSelect.value = selectedSubfolder || "";
}

// Lets the form's creator optionally lock the form to one specific project
// (skips the project picker at fill-out time — see the priority chain in
// openNameSubmissionFileModal/handleConfirmSubmissionFileName). Only
// meaningful once a category is chosen; disabled and reset otherwise, same
// pattern as the subfolder select.
async function renderFileProjectLockOptions(categoryKey, selectedProjectId) {
    const projectSelect = document.getElementById("formFileProjectSelect");
    if (!projectSelect) return;

    if (!categoryKey) {
        projectSelect.innerHTML = `<option value="">Ask which project when filling out</option>`;
        projectSelect.disabled = true;
        projectSelect.value = "";
        return;
    }

    projectSelect.disabled = false;
    projectSelect.innerHTML = `<option value="">Ask which project when filling out</option><option value="" disabled>Loading projects…</option>`;
    const projects = await loadProjectsForPicker();
    projectSelect.innerHTML = `<option value="">Ask which project when filling out</option>` +
        projects.map(p => `<option value="${formEscapeHtml(p.id)}">${formEscapeHtml(p.name || "Untitled project")}</option>`).join("");
    projectSelect.value = selectedProjectId || "";
}

// Reads the category/subfolder/project selects back into a
// {default_category, default_subfolder, default_project_id} payload — all
// null if "No filing" is chosen. Returns `false` (and sets an error
// message) if a category was chosen but no subfolder, since a partial
// mapping can't file anything. default_project_id is only ever non-null
// alongside a real category/subfolder — the select is disabled (and its
// value ignored) whenever category is blank.
function readFileFolderPickerValue(messageEl) {
    const categorySelect = document.getElementById("formFileCategorySelect");
    const subfolderSelect = document.getElementById("formFileSubfolderSelect");
    const projectSelect = document.getElementById("formFileProjectSelect");
    const category = categorySelect ? categorySelect.value : "";
    const subfolder = subfolderSelect ? subfolderSelect.value : "";

    if (!category) return { default_category: null, default_subfolder: null, default_project_id: null };

    if (!subfolder) {
        if (messageEl) { messageEl.textContent = "Choose a subfolder, or set the category back to \"No filing\"."; messageEl.className = "auth-message error"; }
        return false;
    }

    const projectId = projectSelect ? projectSelect.value : "";
    return { default_category: category, default_subfolder: subfolder, default_project_id: projectId || null };
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

/* ---------- projects (for the name-submission-file project picker) ---------- */

// Loaded lazily (first time a project-mapped form is filled without a
// ?project= param) rather than on every page load, since most visits to
// form-template.html never touch a project-mapped form at all.
async function loadProjectsForPicker() {
    if (projectsForPickerLoaded || !window.supabaseClient) return projectsForPicker;
    const PROJECTS_READ_VIEW = (window.ProjectFields && window.ProjectFields.PROJECTS_READ_VIEW) || "projects_overview";

    const { data, error } = await window.supabaseClient
        .from(PROJECTS_READ_VIEW)
        .select("id, name")
        .order("name", { ascending: true });

    if (error) {
        console.error("Failed to load projects for picker:", error);
        return projectsForPicker;
    }

    projectsForPicker = data || [];
    projectsForPickerLoaded = true;
    return projectsForPicker;
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

    const allowAttachmentsCheckbox = document.getElementById("formAllowAttachmentsCheckbox");
    if (allowAttachmentsCheckbox) allowAttachmentsCheckbox.checked = Boolean(record?.allow_attachments);

    await renderFileFolderPicker(record?.default_category || "", record?.default_subfolder || "", record?.default_project_id || "");

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

    const folderMapping = readFileFolderPickerValue(messageEl);
    if (folderMapping === false) return;

    const allowAttachments = document.getElementById("formAllowAttachmentsCheckbox")?.checked || false;

    setFormBuilderSaving(true);
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    try {
        const { data: updated, error } = await window.supabaseClient
            .from(FORM_TEMPLATES_TABLE)
            .update({ title, description, fields: cleanedFields, allow_attachments: allowAttachments, ...folderMapping, updated_at: new Date().toISOString() })
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

    const folderMapping = readFileFolderPickerValue(messageEl);
    if (folderMapping === false) return;

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
            page_count: pdfBuilderPageCount,
            allow_attachments: document.getElementById("formAllowAttachmentsCheckbox")?.checked || false,
            ...folderMapping
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

// Typing the form's own title to confirm (same pattern used for project
// deletion) -- cheap insurance against a one-click delete landing on the
// wrong form, which is otherwise unrecoverable.
function deleteFormConfirmNameMatches() {
    const expected = (editingFormRecord && editingFormRecord.title) || "";
    const typed = document.getElementById("deleteFormConfirmNameInput").value;
    return expected.length > 0 && typed.trim() === expected;
}

function deleteFormConfirmReady() {
    return deleteFormConfirmNameMatches()
        && document.getElementById("deleteFormConfirmUnderstandCheckbox").checked;
}

function updateDeleteFormConfirmBtnState() {
    document.getElementById("confirmDeleteFormBtn").disabled = !deleteFormConfirmReady();
}

function openDeleteFormConfirm() {
    if (!editingFormRecord) return;
    const name = editingFormRecord.title || "this form";
    document.getElementById("deleteFormConfirmName").textContent = name;
    const input = document.getElementById("deleteFormConfirmNameInput");
    input.value = "";
    document.getElementById("deleteFormConfirmUnderstandCheckbox").checked = false;
    const messageEl = document.getElementById("deleteFormConfirmMessage");
    if (messageEl) messageEl.textContent = "";
    document.getElementById("deleteFormConfirmOverlay")?.classList.remove("hidden");
    updateDeleteFormConfirmBtnState();
    input.focus();
}

function closeDeleteFormConfirm() {
    document.getElementById("deleteFormConfirmOverlay")?.classList.add("hidden");
}

async function confirmDeleteForm() {
    if (!editingFormRecord) return;
    if (!deleteFormConfirmReady()) return;
    const record = editingFormRecord;
    const confirmBtn = document.getElementById("confirmDeleteFormBtn");
    const messageEl = document.getElementById("deleteFormConfirmMessage");

    if (confirmBtn) confirmBtn.disabled = true;

    try {
        if (!(await ensureFreshSupabaseSession())) {
            throw Object.assign(new Error(SESSION_EXPIRED_MESSAGE), { isFriendly: true });
        }

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
        if (messageEl) {
            messageEl.textContent = error?.isFriendly
                ? error.message
                : (isAuthSessionError(error) ? SESSION_EXPIRED_MESSAGE : "Something went wrong deleting this form. Please try again.");
        }
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

    initFillFormAttachments(record, existingSubmission);

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
    fillFormAttachments = [];

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

/* ---------- per-submission PDF attachments (fill-out form) ---------- */

// Shows/hides the "Attach files" section and (re)seeds fillFormAttachments
// for the form now open in the fill-out modal — called from
// openFillFormModal(). A brand-new submission starts with an empty list;
// editing an existing one starts from its already-saved attachments
// (path set, file null — the raw bytes aren't re-downloaded unless the
// person removes and re-adds one).
function initFillFormAttachments(record, existingSubmission) {
    const section = document.getElementById("fillFormAttachmentsSection");
    if (section) section.classList.toggle("hidden", !record.allow_attachments);

    fillFormAttachments = (existingSubmission?.attachments || []).map(a => ({
        id: crypto.randomUUID(),
        name: a.name,
        file: null,
        path: a.path
    }));

    const messageEl = document.getElementById("fillFormAttachmentsMessage");
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    renderFillFormAttachmentsList();
}

function renderFillFormAttachmentsList() {
    const listEl = document.getElementById("fillFormAttachmentsList");
    const emptyEl = document.getElementById("fillFormAttachmentsEmpty");
    if (!listEl) return;

    if (emptyEl) emptyEl.classList.toggle("hidden", fillFormAttachments.length > 0);
    listEl.innerHTML = "";

    fillFormAttachments.forEach((attachment, index) => {
        const row = document.createElement("div");
        row.className = "form-attachment-row";
        row.draggable = true;
        row.dataset.id = attachment.id;
        row.innerHTML = `
            <span class="form-attachment-drag-handle" aria-hidden="true" title="Drag to reorder"></span>
            <span class="form-attachment-icon" aria-hidden="true"></span>
            <span class="form-attachment-name">${formEscapeHtml(attachment.name)}</span>
            <div class="form-attachment-row-actions">
                <button type="button" class="form-field-move-btn" data-action="move-up" aria-label="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
                <button type="button" class="form-field-move-btn" data-action="move-down" aria-label="Move down" ${index === fillFormAttachments.length - 1 ? "disabled" : ""}>↓</button>
                <button type="button" class="form-field-remove-btn" data-action="remove" aria-label="Remove ${formEscapeHtml(attachment.name)}">✕</button>
            </div>
        `;

        row.querySelector('[data-action="move-up"]')?.addEventListener("click", () => moveFillFormAttachment(attachment.id, -1));
        row.querySelector('[data-action="move-down"]')?.addEventListener("click", () => moveFillFormAttachment(attachment.id, 1));
        row.querySelector('[data-action="remove"]')?.addEventListener("click", () => removeFillFormAttachment(attachment.id));

        row.addEventListener("dragstart", (e) => {
            fillFormAttachmentDragId = attachment.id;
            e.dataTransfer.effectAllowed = "move";
        });
        row.addEventListener("dragover", (e) => {
            if (!fillFormAttachmentDragId || fillFormAttachmentDragId === attachment.id) return;
            e.preventDefault();
            row.classList.add("form-attachment-drop-target");
        });
        row.addEventListener("dragleave", () => row.classList.remove("form-attachment-drop-target"));
        row.addEventListener("drop", (e) => {
            e.preventDefault();
            row.classList.remove("form-attachment-drop-target");
            if (!fillFormAttachmentDragId || fillFormAttachmentDragId === attachment.id) return;
            reorderFillFormAttachment(fillFormAttachmentDragId, attachment.id);
            fillFormAttachmentDragId = null;
        });

        listEl.appendChild(row);
    });
}

function moveFillFormAttachment(id, delta) {
    const index = fillFormAttachments.findIndex(a => a.id === id);
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= fillFormAttachments.length) return;
    const [moved] = fillFormAttachments.splice(index, 1);
    fillFormAttachments.splice(targetIndex, 0, moved);
    renderFillFormAttachmentsList();
}

function reorderFillFormAttachment(draggedId, targetId) {
    const fromIndex = fillFormAttachments.findIndex(a => a.id === draggedId);
    const toIndex = fillFormAttachments.findIndex(a => a.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = fillFormAttachments.splice(fromIndex, 1);
    fillFormAttachments.splice(toIndex, 0, moved);
    renderFillFormAttachmentsList();
}

function removeFillFormAttachment(id) {
    fillFormAttachments = fillFormAttachments.filter(a => a.id !== id);
    renderFillFormAttachmentsList();
}

// Wired to #fillFormAttachmentsInput's change event. Silently skips
// anything that isn't actually a PDF (the accept="application/pdf" filter
// on the picker is a hint, not an enforcement — some OS file pickers let
// people override it) rather than letting a non-PDF into the merge, where
// PDFLib would just throw later at submit time.
function addFillFormAttachmentFiles(fileList) {
    const messageEl = document.getElementById("fillFormAttachmentsMessage");
    const files = Array.from(fileList || []);
    let skipped = 0;

    files.forEach(file => {
        const looksLikePdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
        if (!looksLikePdf) { skipped++; return; }
        fillFormAttachments.push({ id: crypto.randomUUID(), name: file.name, file, path: null });
    });

    if (messageEl) {
        messageEl.textContent = skipped ? `Skipped ${skipped} file${skipped > 1 ? "s" : ""} — only PDFs can be attached.` : "";
        messageEl.className = skipped ? "auth-message error" : "auth-message";
    }

    renderFillFormAttachmentsList();
}

// Reads an attachment's raw bytes from whichever source it currently has —
// a fresh File (a new attachment picked this session) or an existing
// storage path (one kept as-is while editing) — so both look the same to
// mergeSubmissionAttachments()/PDFLib below.
async function fetchAttachmentBytes(attachment) {
    if (attachment.file) return attachment.file.arrayBuffer();
    const { data, error } = await window.supabaseClient
        .storage
        .from(FORM_SUBMISSIONS_BUCKET)
        .download(attachment.path);
    if (error) throw error;
    return data.arrayBuffer();
}

// Merges the base submission PDF with every attached PDF, in the order
// they're arranged in the Attach files list, into one output PDF — the
// base form's own pages first, then each attachment's pages in sequence.
// Returns baseBlob unchanged (no-op) when there are no attachments, so
// forms without this feature enabled see zero behavior change.
async function mergeSubmissionAttachments(baseBlob, attachments) {
    if (!attachments.length) return baseBlob;
    if (typeof PDFLib === "undefined") throw new Error("PDF library failed to load");

    const mergedDoc = await PDFLib.PDFDocument.create();

    const baseBytes = await baseBlob.arrayBuffer();
    const baseDoc = await PDFLib.PDFDocument.load(baseBytes);
    (await mergedDoc.copyPages(baseDoc, baseDoc.getPageIndices())).forEach(p => mergedDoc.addPage(p));

    for (const attachment of attachments) {
        let bytes;
        try {
            bytes = await fetchAttachmentBytes(attachment);
        } catch (error) {
            const friendly = new Error(`Couldn't read "${attachment.name}". Please try re-attaching it.`);
            friendly.isFriendly = true;
            throw friendly;
        }
        let attachDoc;
        try {
            attachDoc = await PDFLib.PDFDocument.load(bytes);
        } catch (error) {
            const friendly = new Error(`"${attachment.name}" isn't a valid PDF and couldn't be added.`);
            friendly.isFriendly = true;
            throw friendly;
        }
        (await mergedDoc.copyPages(attachDoc, attachDoc.getPageIndices())).forEach(p => mergedDoc.addPage(p));
    }

    const finalBytes = await mergedDoc.save();
    return new Blob([finalBytes], { type: "application/pdf" });
}

// Uploads the raw bytes of any newly-added attachment (attachment.file set)
// to storage so it can be re-fetched and re-merged on a future edit, and
// returns the final ordered [{name, path}] metadata to save on the
// submission row. Attachments already in storage (attachment.path set,
// kept as-is) pass through unchanged.
async function persistFillFormAttachments(formId, submissionId, attachments) {
    const metadata = [];
    for (let i = 0; i < attachments.length; i++) {
        const attachment = attachments[i];
        if (attachment.file) {
            const safeBaseName = sanitizeSubmissionFileName(attachment.name).replace(/\.pdf$/i, "");
            const path = `${formId}/${submissionId}/attachments/${i}-${safeBaseName}.pdf`;
            const { error } = await window.supabaseClient
                .storage
                .from(FORM_SUBMISSIONS_BUCKET)
                .upload(path, attachment.file, { cacheControl: "3600", upsert: true, contentType: "application/pdf" });
            if (error) throw error;
            metadata.push({ name: attachment.name, path });
        } else if (attachment.path) {
            metadata.push({ name: attachment.name, path: attachment.path });
        }
    }
    return metadata;
}

// After a save, removes from storage any attachment that was on the
// submission before this edit but isn't in the final saved list — i.e.
// something the person removed this pass. Best-effort: logs and moves on
// rather than failing the save over a cleanup step.
async function cleanupDetachedAttachments(previousAttachments, currentAttachments) {
    const keptPaths = new Set(currentAttachments.map(a => a.path));
    const removedPaths = (previousAttachments || []).map(a => a.path).filter(p => p && !keptPaths.has(p));
    if (!removedPaths.length) return;

    const { error } = await window.supabaseClient.storage.from(FORM_SUBMISSIONS_BUCKET).remove(removedPaths);
    if (error) console.error("Failed to remove detached attachment(s) from storage:", error);
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

// Step 1 of submitting: validate the answers, then hand off to the "Name
// this file" popup rather than uploading right away — the actual PDF
// build + upload happens in handleConfirmSubmissionFileName() once a name
// has been chosen.
async function handleSubmitFillForm(event) {
    event.preventDefault();
    if (!fillFormRecord) return;

    const record = fillFormRecord;
    const isEditing = Boolean(editingSubmission);
    const messageEl = document.getElementById("fillFormMessage");
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

    // Attachments always merge via PDFLib regardless of legacy vs. PDF-based
    // form (a legacy form's own base PDF comes from pdfMake, not PDFLib —
    // the isPdfForm check above only covers that base build, not the merge).
    if (fillFormAttachments.length && typeof PDFLib === "undefined") {
        if (messageEl) {
            messageEl.textContent = "The PDF library failed to load. Refresh and try again.";
            messageEl.className = "auth-message error";
        }
        return;
    }

    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    const submittedByName = isEditing ? (editingSubmission.submitted_by_name || "Staff") : getFormStaffName();
    const submittedById = isEditing ? editingSubmission.submitted_by : getFormStaffId();

    // On an edit, the generated PDF's footer keeps crediting the original
    // submitter/date and adds who edited it and when — it doesn't rewrite
    // history to look like a fresh submission just because the file got
    // regenerated.
    const footerText = isEditing
        ? `Submitted by ${submittedByName} on ${new Date(editingSubmission.created_at).toLocaleString()} • Edited by ${getFormStaffName()} on ${new Date().toLocaleString()}`
        : `Submitted by ${submittedByName} on ${new Date().toLocaleString()}`;

    // Snapshot the attachment list as it stands right now — the fill-out
    // modal gets hidden (not reset) while the "Name this file" popup is up,
    // so fillFormAttachments itself stays live and shouldn't be trusted to
    // hold still until handleConfirmSubmissionFileName() actually runs.
    pendingSubmission = { record, isEditing, isPdfForm, answers: result.answers, footerText, submittedByName, submittedById, attachments: fillFormAttachments.slice() };
    openNameSubmissionFileModal();
}

// Strips characters that aren't safe in a downloaded filename. Keeps it
// simple/permissive (spaces, letters, numbers, most punctuation) rather
// than trying to allowlist every valid filesystem character.
function sanitizeSubmissionFileName(name) {
    const cleaned = String(name || "").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
    return cleaned.slice(0, 120) || "Form submission";
}

// Guarantees a name ends in exactly one ".pdf" (strips any existing one
// first, case-insensitively, then adds it back) — every submission's own
// underlying file genuinely is a PDF (the base form, or the base form
// merged with its attachments), but sanitizeSubmissionFileName() itself
// deliberately doesn't enforce that, since it's also reused for attachment
// base names (see addFillFormAttachmentFiles()), where forcing an
// extension on would be wrong. Kept separate so callers that want a real
// PDF-suffixed name opt into it explicitly.
function ensurePdfExtension(name) {
    const trimmed = String(name || "").trim();
    return `${trimmed.replace(/\.pdf$/i, "")}.pdf`;
}

async function openNameSubmissionFileModal() {
    if (!pendingSubmission) return;
    const { record, isEditing } = pendingSubmission;

    const input = document.getElementById("submissionFileNameInput");
    if (input) {
        input.value = isEditing
            ? (editingSubmission?.file_name || record.title || "")
            : (record.title || "");
    }

    const messageEl = document.getElementById("nameSubmissionFileMessage");
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    const confirmBtn = document.getElementById("confirmNameSubmissionFileBtn");
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "Submit"; }

    // Project picker: only for a project-mapped template (default_category
    // set) — and only when we don't already know the project from the URL
    // (came here via a project's All Files page "+ Fill <template>" link),
    // from the submission being edited, or from the form itself being
    // locked to one project (default_project_id — see the Add/Edit Form
    // modal's "File submissions into a project folder?" section).
    const projectRow = document.getElementById("submissionProjectRow");
    const projectSelect = document.getElementById("submissionProjectSelect");
    const isProjectMapped = Boolean(record.default_category && record.default_subfolder);
    const knownProjectId = projectIdFromUrl || (isEditing ? editingSubmission?.project_id : null) || record.default_project_id || null;

    if (projectRow && projectSelect) {
        if (isProjectMapped && !knownProjectId) {
            projectRow.style.display = "block";
            projectSelect.innerHTML = `<option value="">Loading projects…</option>`;
            const projects = await loadProjectsForPicker();
            projectSelect.innerHTML = projects.length
                ? projects.map(p => `<option value="${formEscapeHtml(p.id)}">${formEscapeHtml(p.name || "Untitled project")}</option>`).join("")
                : `<option value="">No projects available</option>`;
            if (isEditing && editingSubmission?.project_id) projectSelect.value = editingSubmission.project_id;
        } else {
            projectRow.style.display = "none";
            projectSelect.innerHTML = "";
        }
    }

    document.getElementById("nameSubmissionFileModalOverlay")?.classList.remove("hidden");
    document.body.classList.add("popup-active");
    input?.focus();
}

// Cancelling just backs out of the name popup — the fill-out form
// underneath is left exactly as filled in, nothing has been uploaded yet.
function closeNameSubmissionFileModal() {
    document.getElementById("nameSubmissionFileModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
    pendingSubmission = null;
}

// Step 2 of submitting: now that a file name has been chosen, actually
// build the PDF and upload it (the part handleSubmitFillForm used to do
// immediately, before the naming step existed).
async function handleConfirmSubmissionFileName(event) {
    event.preventDefault();
    if (!pendingSubmission) return;

    const { record, isEditing, isPdfForm, answers, footerText, submittedByName, submittedById, attachments } = pendingSubmission;

    // Always stored (and displayed everywhere — the Responses list, All
    // Files) with a real .pdf suffix, not just whatever the person typed —
    // the underlying file is always a PDF regardless of what name they
    // gave it, and All Files' own preview/download rely on the extension
    // to know how to render/save it (see project-files.js's
    // getPreviewKind()).
    const nameInput = document.getElementById("submissionFileNameInput");
    const fileName = ensurePdfExtension(sanitizeSubmissionFileName(nameInput ? nameInput.value : ""));
    const messageEl = document.getElementById("nameSubmissionFileMessage");
    const confirmBtn = document.getElementById("confirmNameSubmissionFileBtn");
    const fillMessageEl = document.getElementById("fillFormMessage");

    // Project this submission files into, in priority order: known from the
    // URL/the submission being edited/the form's own project lock, otherwise
    // whatever was picked in the project select just shown (blank/no select
    // = not a project-mapped form, stays null exactly like it does today).
    const isProjectMapped = Boolean(record.default_category && record.default_subfolder);
    const projectSelect = document.getElementById("submissionProjectSelect");
    const knownProjectId = projectIdFromUrl || (isEditing ? editingSubmission?.project_id : null) || record.default_project_id || null;
    const projectId = isProjectMapped ? (knownProjectId || projectSelect?.value || null) : null;

    if (isProjectMapped && !projectId) {
        if (messageEl) { messageEl.textContent = "Choose which project this belongs to."; messageEl.className = "auth-message error"; }
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = isEditing ? "Save changes" : "Submit"; }
        return;
    }

    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = isEditing ? "Saving…" : "Submitting…"; }
    if (messageEl) { messageEl.textContent = isEditing ? "Saving…" : "Submitting…"; messageEl.className = "auth-message"; }

    try {
        if (!(await ensureFreshSupabaseSession())) {
            throw Object.assign(new Error(SESSION_EXPIRED_MESSAGE), { isFriendly: true });
        }

        const baseBlob = isPdfForm
            ? await buildPdfSubmissionBlob(record, answers)
            : await pdfMake.createPdf(buildSubmissionPdfDocDefinition(record, answers, footerText)).getBlob();

        // Attaches merge onto the end of the base PDF, in the order they're
        // arranged in the Attach files list — a no-op passthrough when
        // there are none, so this line is safe to run unconditionally.
        const blob = await mergeSubmissionAttachments(baseBlob, attachments || []);

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

            // Uploads any newly-added attachment's raw bytes (kept
            // separately from the merged PDF above so they can be re-fetched
            // and re-merged on a future edit); attachments still present
            // from before this edit pass through unchanged.
            const attachmentsMetadata = await persistFillFormAttachments(record.id, submissionId, attachments || []);

            const { error: updateError } = await window.supabaseClient
                .from(FORM_SUBMISSIONS_TABLE)
                .update({
                    answers,
                    pdf_path: pdfPath,
                    file_name: fileName,
                    project_id: projectId,
                    attachments: attachmentsMetadata,
                    edited_at: new Date().toISOString(),
                    edited_by: getFormStaffId(),
                    edited_by_name: getFormStaffName()
                })
                .eq("id", submissionId);
            if (updateError) throw updateError;

            // Best-effort cleanup: any attachment this edit removed no
            // longer has a reason to sit in storage. Doesn't block the save
            // on a cleanup failure (e.g. it was already gone) — the answers/
            // attachments the person actually asked to save just did.
            await cleanupDetachedAttachments(editingSubmission.attachments || [], attachmentsMetadata);

            closeNameSubmissionFileModal();
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

            const attachmentsMetadata = await persistFillFormAttachments(record.id, submissionId, attachments || []);

            const { error: insertError } = await window.supabaseClient
                .from(FORM_SUBMISSIONS_TABLE)
                .insert({
                    id: submissionId,
                    form_id: record.id,
                    form_title: record.title,
                    submitted_by: submittedById,
                    submitted_by_name: submittedByName,
                    answers,
                    pdf_path: pdfPath,
                    file_name: fileName,
                    project_id: projectId,
                    attachments: attachmentsMetadata
                });
            if (insertError) throw insertError;

            if (submittedById) {
                await window.supabaseClient.from("notifications").insert({
                    user_id: submittedById,
                    title: "Form submitted",
                    message: `Your "${record.title}" form has been submitted.`,
                    type: "form_submission",
                    link_url: `/pages/form-template.html?viewSubmission=${submissionId}`,
                    link_label: "View it here"
                });
            }

            closeNameSubmissionFileModal();
            closeFillFormModal();
            showFormPageMessage(`Thanks — "${fileName}" was submitted.`, "success");
        }
    } catch (error) {
        console.error(isEditing ? "Failed to save response:" : "Failed to submit form:", error);
        if (messageEl) {
            messageEl.textContent = error?.isFriendly
                ? error.message
                : (isAuthSessionError(error) ? SESSION_EXPIRED_MESSAGE : "Something went wrong. Please try again.");
            messageEl.className = "auth-message error";
        }
        if (fillMessageEl) { fillMessageEl.textContent = ""; fillMessageEl.className = "auth-message"; }
    } finally {
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = isEditing ? "Save changes" : "Submit"; }
    }
}

/* ---------- responses modal ---------- */

async function openResponsesModal(record) {
    responsesFormRecord = record;
    responsesCurrentSubmissions = [];
    updateDownloadAllResponsesBtnState();

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

    responsesCurrentSubmissions = data || [];
    updateDownloadAllResponsesBtnState();

    if (!data || !data.length) {
        if (listEl) listEl.innerHTML = `<p class="workbook-preview-empty">No responses yet.</p>`;
        return;
    }

    if (listEl) {
        listEl.innerHTML = "";
        data.forEach(submission => {
            const editedNote = submission.edited_at
                ? `<p class="form-response-edited">Edited ${formEscapeHtml(formatFormDate(submission.edited_at))}${submission.edited_by_name ? ` by ${formEscapeHtml(submission.edited_by_name)}` : ""}</p>`
                : "";
            const displayName = submission.file_name || submission.form_title || "Untitled submission";

            const row = document.createElement("div");
            row.className = "form-response-row";
            row.innerHTML = `
                <div class="form-response-file-icon"><span></span></div>
                <div class="form-response-info">
                    <p class="form-response-name">${formEscapeHtml(displayName)}</p>
                    <p class="form-response-meta">Submitted by ${formEscapeHtml(submission.submitted_by_name || "Staff")} on ${formEscapeHtml(formatFormDate(submission.created_at))}</p>
                    ${editedNote}
                </div>
                <div class="form-response-actions">
                    <button type="button" class="form-response-menu-btn" data-action="menu" aria-label="Response actions" aria-haspopup="true" aria-expanded="false">
                        <span class="form-response-menu-icon"></span>
                    </button>
                    <div class="form-response-menu-dropdown">
                        <button type="button" class="form-response-menu-item" data-action="view">View PDF</button>
                        <button type="button" class="form-response-menu-item" data-action="download">Download</button>
                        <button type="button" class="form-response-menu-item" data-action="edit">Edit</button>
                        <div class="form-response-menu-divider"></div>
                        <button type="button" class="form-response-menu-item form-response-menu-item--danger" data-action="delete">Delete</button>
                    </div>
                </div>
            `;

            const menuBtn = row.querySelector('[data-action="menu"]');
            const dropdown = row.querySelector(".form-response-menu-dropdown");
            menuBtn?.addEventListener("click", (event) => {
                event.stopPropagation();
                toggleResponseRowMenu(menuBtn, dropdown);
            });

            row.querySelector('[data-action="view"]')
                ?.addEventListener("click", () => { closeAllResponseRowMenus(); viewFormSubmission(submission); });
            const downloadBtn = row.querySelector('[data-action="download"]');
            downloadBtn?.addEventListener("click", () => { closeAllResponseRowMenus(); downloadFormSubmission(submission, downloadBtn); });
            row.querySelector('[data-action="edit"]')
                ?.addEventListener("click", () => { closeAllResponseRowMenus(); openEditSubmissionModal(record, submission); });
            row.querySelector('[data-action="delete"]')
                ?.addEventListener("click", () => { closeAllResponseRowMenus(); openDeleteSubmissionConfirm(record, submission); });

            listEl.appendChild(row);
        });
    }
}

/* ---------- per-row "⋯" menu ---------- */
// Same open/toggle/close-all shape as All Files' per-file menu
// (project-files.js's openFileRowMenu/toggleFileRowMenu/closeAllFileMenus)
// — only one row's dropdown open at a time, closed on an outside click or
// Escape (wired in the DOMContentLoaded block below).

function openResponseRowMenu(menuBtn, dropdown) {
    closeAllResponseRowMenus();
    if (!dropdown || !menuBtn) return;
    dropdown.classList.add("is-open");
    menuBtn.classList.add("is-open");
    menuBtn.setAttribute("aria-expanded", "true");
    positionResponseMenuDropdown(menuBtn, dropdown);
}

// The dropdown is position: fixed (see its CSS rule for why -- escaping
// #formResponsesList's internal scroll clipping), so unlike the old
// position: absolute it no longer anchors itself to the "⋯" button on
// its own. Same clamp-to-viewport approach as positionPdfPopover above:
// right-align under the button by default (matching the old `right: 0`
// look), nudge back on screen if that would run off an edge, and flip
// above the button if there's no room below it.
function positionResponseMenuDropdown(menuBtn, dropdown) {
    const margin = 4;
    const btnRect = menuBtn.getBoundingClientRect();
    const dropRect = dropdown.getBoundingClientRect();

    let left = btnRect.right - dropRect.width;
    if (left < margin) left = margin;
    if (left + dropRect.width > window.innerWidth - margin) {
        left = window.innerWidth - dropRect.width - margin;
    }

    let top = btnRect.bottom + margin;
    if (top + dropRect.height > window.innerHeight - margin) {
        top = btnRect.top - dropRect.height - margin;
    }

    dropdown.style.left = `${Math.max(margin, left)}px`;
    dropdown.style.top = `${Math.max(margin, top)}px`;
}

function toggleResponseRowMenu(menuBtn, dropdown) {
    const isOpen = dropdown?.classList.contains("is-open");
    if (isOpen) { closeAllResponseRowMenus(); return; }
    openResponseRowMenu(menuBtn, dropdown);
}

function closeAllResponseRowMenus() {
    document.querySelectorAll(".form-response-menu-dropdown.is-open").forEach(d => d.classList.remove("is-open"));
    document.querySelectorAll(".form-response-menu-btn.is-open").forEach(b => {
        b.classList.remove("is-open");
        b.setAttribute("aria-expanded", "false");
    });
}

/* ---------- "Download All" ---------- */

function updateDownloadAllResponsesBtnState() {
    const btn = document.getElementById("downloadAllResponsesBtn");
    if (!btn) return;
    btn.disabled = !responsesCurrentSubmissions.some(s => s.pdf_path);
}

// Bundles every response's PDF into a single .zip (via JSZip, loaded from
// jsdelivr in form-template.html alongside the app's other CDN libraries)
// rather than triggering one browser download per file — one file to
// save, and no risk of a browser's "this site is downloading multiple
// files" guard silently blocking anything past the first couple.
async function downloadAllFormResponses() {
    const btn = document.getElementById("downloadAllResponsesBtn");
    const label = btn?.querySelector(".form-responses-download-all-label");
    const downloadable = responsesCurrentSubmissions.filter(s => s.pdf_path);
    if (!btn || !downloadable.length) return;

    if (typeof JSZip === "undefined") {
        console.error("JSZip failed to load — can't build the responses zip.");
        alert("Couldn't build the zip file. Please refresh and try again.");
        return;
    }

    btn.disabled = true;
    const originalLabel = label ? label.textContent : "";
    const zip = new JSZip();
    const usedZipNames = new Set(); // two submissions can share a chosen file name (or both fall back to the form title) — zip entries need unique names

    try {
        for (let i = 0; i < downloadable.length; i++) {
            if (label) label.textContent = downloadable.length > 1 ? `Zipping ${i + 1} of ${downloadable.length}…` : "Zipping…";
            const submission = downloadable[i];
            const blob = await fetchSubmissionPdfBlob(submission);

            // submission.file_name already ends in .pdf for anything saved
            // since ensurePdfExtension() was added above — strip it back off
            // here so it isn't doubled, since older submissions saved before
            // that fix won't have it and still need it added once.
            const baseName = sanitizeSubmissionFileName(submission.file_name || submission.form_title).replace(/\.pdf$/i, "");
            let zipName = `${baseName}.pdf`;
            for (let suffix = 2; usedZipNames.has(zipName); suffix++) zipName = `${baseName} (${suffix}).pdf`;
            usedZipNames.add(zipName);

            zip.file(zipName, blob);
        }

        if (label) label.textContent = "Preparing download…";
        const zipBlob = await zip.generateAsync({ type: "blob" });

        const objectUrl = URL.createObjectURL(zipBlob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = `${sanitizeSubmissionFileName(`${responsesFormRecord?.title || "Form"} responses`)}.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectUrl);
    } catch (error) {
        console.error("Failed to build responses zip:", error);
        alert("Couldn't download all responses. Please try again.");
    } finally {
        if (label) label.textContent = originalLabel;
        btn.disabled = false;
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
    responsesCurrentSubmissions = [];
    closeAllResponseRowMenus();
}

/* ---------- delete a submission ---------- */
// Reuses the same "hide the Responses modal underneath while this one's
// open, reveal it again on close" trick as openEditSubmissionModal, since
// this popup is opened from inside the Responses modal too.

let submissionPendingDeleteName = "";

// Typing the submission's own name to confirm (same pattern used for
// project deletion) -- cheap insurance against a one-click delete landing
// on the wrong response, which is otherwise unrecoverable.
function deleteSubmissionConfirmNameMatches() {
    const typed = document.getElementById("deleteSubmissionConfirmNameInput").value;
    return submissionPendingDeleteName.length > 0 && typed.trim() === submissionPendingDeleteName;
}

function deleteSubmissionConfirmReady() {
    return deleteSubmissionConfirmNameMatches()
        && document.getElementById("deleteSubmissionConfirmUnderstandCheckbox").checked;
}

function updateDeleteSubmissionConfirmBtnState() {
    document.getElementById("confirmDeleteSubmissionBtn").disabled = !deleteSubmissionConfirmReady();
}

function openDeleteSubmissionConfirm(record, submission) {
    submissionPendingDelete = { record, submission };
    submissionPendingDeleteName = submission.file_name || submission.form_title || "";

    document.getElementById("deleteSubmissionConfirmName").textContent = submissionPendingDeleteName || "this submission";
    const copyEl = document.getElementById("deleteSubmissionConfirmCopy");
    if (copyEl) copyEl.textContent = "This will permanently delete this submission and its PDF. This action cannot be undone.";

    const input = document.getElementById("deleteSubmissionConfirmNameInput");
    input.value = "";
    document.getElementById("deleteSubmissionConfirmUnderstandCheckbox").checked = false;

    const messageEl = document.getElementById("deleteSubmissionConfirmMessage");
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    document.getElementById("formResponsesModalOverlay")?.classList.add("hidden");
    document.getElementById("deleteSubmissionConfirmOverlay")?.classList.remove("hidden");
    document.body.classList.add("popup-active");
    updateDeleteSubmissionConfirmBtnState();
    input.focus();
}

function closeDeleteSubmissionConfirm() {
    document.getElementById("deleteSubmissionConfirmOverlay")?.classList.add("hidden");
    submissionPendingDelete = null;
    submissionPendingDeleteName = "";
    // Reveal the Responses modal again, refreshed if a delete actually
    // happened (harmless no-op re-fetch if the user just hit Cancel).
    if (responsesFormRecord) {
        openResponsesModal(responsesFormRecord);
    } else {
        document.body.classList.remove("popup-active");
    }
}

async function confirmDeleteSubmission() {
    if (!submissionPendingDelete) return;
    if (!deleteSubmissionConfirmReady()) return;
    const { submission } = submissionPendingDelete;
    const confirmBtn = document.getElementById("confirmDeleteSubmissionBtn");
    const messageEl = document.getElementById("deleteSubmissionConfirmMessage");

    if (confirmBtn) confirmBtn.disabled = true;

    try {
        // Submission's own merged PDF, plus any attachment originals kept
        // separately in storage for re-merging on edit — both are done with
        // once the record itself is gone.
        const pathsToRemove = [submission.pdf_path, ...(submission.attachments || []).map(a => a.path)].filter(Boolean);
        if (pathsToRemove.length) {
            const { error: storageError } = await window.supabaseClient
                .storage
                .from(FORM_SUBMISSIONS_BUCKET)
                .remove(pathsToRemove);
            // Don't block the delete on a storage cleanup failure (e.g. the
            // file was already gone) — the response record disappearing is
            // what the person actually asked for.
            if (storageError) console.error("Failed to remove submission files from storage:", storageError);
        }

        const { error: deleteError } = await window.supabaseClient
            .from(FORM_SUBMISSIONS_TABLE)
            .delete()
            .eq("id", submission.id);
        if (deleteError) throw deleteError;

        closeDeleteSubmissionConfirm(); // re-opens + refreshes the Responses modal
        showFormPageMessage(`"${submission.file_name || submission.form_title || "Submission"}" was deleted.`, "success");
    } catch (error) {
        console.error("Failed to delete submission:", error);
        if (messageEl) { messageEl.textContent = "Something went wrong deleting this response. Please try again."; messageEl.className = "auth-message error"; }
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

/* ---------- submission PDF preview (signed URL, bucket is private) ---------- */

async function viewFormSubmission(submission) {
    if (!submission?.pdf_path) return;

    previewingSubmission = submission;

    const overlay = document.getElementById("submissionPreviewModalOverlay");
    const titleEl = document.getElementById("submissionPreviewTitle");
    const container = document.getElementById("submissionPreviewContainer");
    const messageEl = document.getElementById("submissionPreviewMessage");

    if (titleEl) titleEl.textContent = submission.file_name || submission.form_title || "Form submission";
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
    previewingSubmission = null;
}

// Fetches one submission's PDF as a Blob via a short-lived signed URL.
// Shared by the single-file "Download" action (downloadFormSubmission
// below) and "Download All" (downloadAllFormResponses, which zips several
// of these together) so both go through the exact same fetch path.
async function fetchSubmissionPdfBlob(submission) {
    const { data, error } = await window.supabaseClient
        .storage
        .from(FORM_SUBMISSIONS_BUCKET)
        .createSignedUrl(submission.pdf_path, 60);
    if (error || !data?.signedUrl) throw error || new Error("No signed URL returned");

    const response = await fetch(data.signedUrl);
    if (!response.ok) throw new Error(`Download fetch failed: ${response.status}`);
    return response.blob();
}

// Downloads a submission's PDF to the person's computer under the name
// they chose in the "Name this file" popup at submit time (falling back to
// the form's title for submissions made before that feature existed).
// Fetches the file as a blob first rather than just linking the signed
// URL — a plain <a download> on a cross-origin Supabase Storage URL can't
// force a custom filename, but a same-origin blob: URL can.
//
// Doesn't touch triggerBtn's textContent — it's called both by the
// labeled "Download" button in the PDF preview modal and by the "Download"
// item in the Responses list's "⋯" menu — a disabled/dimmed class covers
// the busy state for both without caring which kind it is.
async function downloadFormSubmission(submission, triggerBtn) {
    if (!submission?.pdf_path) return;

    if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.classList.add("is-busy"); }

    try {
        const blob = await fetchSubmissionPdfBlob(submission);

        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = ensurePdfExtension(sanitizeSubmissionFileName(submission.file_name || submission.form_title));
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectUrl);
    } catch (error) {
        console.error("Failed to download submission PDF:", error);
        alert("Couldn't download that file. Please try again.");
    } finally {
        if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.classList.remove("is-busy"); }
    }
}

// If we landed here from a project's All Files page ("+ Fill <template>"),
// open that template's fill-out modal directly instead of making the person
// find it in the grid — form-files.html links here as
// form-template.html?project=<id>&template=<templateId>.
async function checkForTemplateLinkParam() {
    if (!templateIdFromUrl) return;
    const record = formRecords.find(r => r.id === templateIdFromUrl);
    if (!record) return;
    openFillFormModal(record);
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
    const urlParams = new URLSearchParams(window.location.search);
    projectIdFromUrl = urlParams.get("project") || null;
    templateIdFromUrl = urlParams.get("template") || null;

    loadFormTemplates().then(() => {
        checkForSubmissionLinkParam();
        checkForTemplateLinkParam();
    });
    initFormSearch();

    document.getElementById("formFileCategorySelect")?.addEventListener("change", (e) => {
        renderFileSubfolderOptions(e.target.value, "");
        renderFileProjectLockOptions(e.target.value, "");
    });

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
    document.getElementById("deleteFormConfirmNameInput")?.addEventListener("input", updateDeleteFormConfirmBtnState);
    document.getElementById("deleteFormConfirmUnderstandCheckbox")?.addEventListener("change", updateDeleteFormConfirmBtnState);

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
    document.getElementById("fillFormAttachmentsInput")?.addEventListener("change", (e) => {
        addFillFormAttachmentFiles(e.target.files);
        e.target.value = ""; // allow picking the same file again later (e.g. after removing it)
    });

    document.getElementById("nameSubmissionFileForm")?.addEventListener("submit", handleConfirmSubmissionFileName);
    document.getElementById("cancelNameSubmissionFileBtn")?.addEventListener("click", closeNameSubmissionFileModal);
    document.getElementById("closeNameSubmissionFileBtn")?.addEventListener("click", closeNameSubmissionFileModal);

    document.getElementById("closeFormResponsesBtn")?.addEventListener("click", closeResponsesModal);
    document.getElementById("downloadAllResponsesBtn")?.addEventListener("click", downloadAllFormResponses);
    document.getElementById("closeSubmissionPreviewBtn")?.addEventListener("click", closeSubmissionPreviewModal);
    document.getElementById("downloadSubmissionBtn")?.addEventListener("click", function () {
        if (previewingSubmission) downloadFormSubmission(previewingSubmission, this);
    });

    document.getElementById("cancelDeleteSubmissionBtn")?.addEventListener("click", closeDeleteSubmissionConfirm);
    document.getElementById("confirmDeleteSubmissionBtn")?.addEventListener("click", confirmDeleteSubmission);
    document.getElementById("deleteSubmissionConfirmNameInput")?.addEventListener("input", updateDeleteSubmissionConfirmBtnState);
    document.getElementById("deleteSubmissionConfirmUnderstandCheckbox")?.addEventListener("change", updateDeleteSubmissionConfirmBtnState);

    document.getElementById("formBuilderModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeFormBuilderModal();
    });
    document.getElementById("fillFormModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeFillFormModal();
    });
    document.getElementById("nameSubmissionFileModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeNameSubmissionFileModal();
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
    document.getElementById("deleteSubmissionConfirmOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeDeleteSubmissionConfirm();
    });

    // Close an open response row "⋯" menu on an outside click or Escape —
    // same pattern as All Files' per-file menu (project-files.js).
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".form-response-actions")) closeAllResponseRowMenus();
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeAllResponseRowMenus();
    });
    // The dropdown is position: fixed now (see its CSS rule), so it no
    // longer scrolls along with its row -- close it if the list scrolls
    // instead of leaving it floating over the wrong row.
    document.getElementById("formResponsesList")?.addEventListener("scroll", closeAllResponseRowMenus, { passive: true });
});
