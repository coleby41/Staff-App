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

let formRecords = [];
let editingFormRecord = null;   // the form_templates row being edited, or null for a new form
let editingFields = [];         // working copy of the fields array while the builder modal is open
let fillFormRecord = null;      // the form currently open in the fill-out modal
let responsesFormRecord = null; // the form currently open in the Responses modal

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

/* ---------- builder modal: open/close/save/delete ---------- */

function openFormBuilderModal(record) {
    editingFormRecord = record || null;
    editingFields = record && Array.isArray(record.fields)
        ? JSON.parse(JSON.stringify(record.fields))
        : [];

    const titleEl = document.getElementById("formBuilderModalTitle");
    const subtitleEl = document.getElementById("formBuilderModalSubtitle");
    const idInput = document.getElementById("formIdInput");
    const titleInput = document.getElementById("formTitleInput");
    const descriptionInput = document.getElementById("formDescriptionInput");
    const messageEl = document.getElementById("formBuilderMessage");
    const saveBtn = document.getElementById("saveFormBtn");
    const deleteBtn = document.getElementById("deleteFormBtn");

    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    if (record) {
        if (titleEl) titleEl.textContent = "Edit Form";
        if (subtitleEl) subtitleEl.textContent = "Update the form's questions, or delete it below.";
        if (idInput) idInput.value = record.id;
        if (titleInput) titleInput.value = record.title || "";
        if (descriptionInput) descriptionInput.value = record.description || "";
        if (saveBtn) saveBtn.textContent = "Save changes";
        if (deleteBtn) deleteBtn.style.display = "block";
    } else {
        if (titleEl) titleEl.textContent = "New Form";
        if (subtitleEl) subtitleEl.textContent = "Build the form by adding questions below.";
        if (idInput) idInput.value = "";
        if (titleInput) titleInput.value = "";
        if (descriptionInput) descriptionInput.value = "";
        if (saveBtn) saveBtn.textContent = "Create form";
        if (deleteBtn) deleteBtn.style.display = "none";
    }

    renderFieldEditorList();

    document.getElementById("formBuilderModalOverlay")?.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeFormBuilderModal() {
    document.getElementById("formBuilderModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
    editingFormRecord = null;
    editingFields = [];
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

    const cleanedFields = editingFields
        .map(f => ({ ...f, label: (f.label || "").trim() }))
        .filter(f => f.label);

    if (!cleanedFields.length) {
        if (messageEl) { messageEl.textContent = "Add at least one question with a label."; messageEl.className = "auth-message error"; }
        return;
    }

    if (!window.supabaseClient) {
        if (messageEl) { messageEl.textContent = "Couldn't connect to Supabase. Please refresh and try again."; messageEl.className = "auth-message error"; }
        return;
    }

    setFormBuilderSaving(true);
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    try {
        if (editingFormRecord) {
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
        } else {
            const { data: inserted, error } = await window.supabaseClient
                .from(FORM_TEMPLATES_TABLE)
                .insert({
                    title,
                    description,
                    fields: cleanedFields,
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

function openFillFormModal(record) {
    fillFormRecord = record;

    const titleEl = document.getElementById("fillFormTitle");
    const descriptionEl = document.getElementById("fillFormDescription");
    const container = document.getElementById("fillFormFieldsContainer");
    const messageEl = document.getElementById("fillFormMessage");

    if (titleEl) titleEl.textContent = record.title;
    if (descriptionEl) descriptionEl.textContent = record.description || "";
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    if (container) {
        container.innerHTML = (record.fields || []).map(renderFillField).join("");
    }

    document.getElementById("fillFormModalOverlay")?.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeFillFormModal() {
    document.getElementById("fillFormModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
    fillFormRecord = null;
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

function buildSubmissionPdfDocDefinition(record, answers, submittedByName) {
    const content = [
        { text: record.title, bold: true, fontSize: 18, margin: [0, 0, 0, 4] }
    ];

    if (record.description) {
        content.push({ text: record.description, italics: true, color: "#555555", margin: [0, 0, 0, 10] });
    }

    content.push({
        text: `Submitted by ${submittedByName} on ${new Date().toLocaleString()}`,
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

async function handleSubmitFillForm(event) {
    event.preventDefault();
    if (!fillFormRecord) return;

    const record = fillFormRecord;
    const messageEl = document.getElementById("fillFormMessage");
    const submitBtn = document.getElementById("submitFillFormBtn");

    const result = collectFillAnswers(record);
    if (!result.ok) {
        if (messageEl) {
            messageEl.textContent = `Please answer "${result.missingLabel}" before submitting.`;
            messageEl.className = "auth-message error";
        }
        return;
    }

    if (typeof pdfMake === "undefined") {
        if (messageEl) {
            messageEl.textContent = "The PDF library failed to load. Refresh and try again.";
            messageEl.className = "auth-message error";
        }
        return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Submitting…"; }
    if (messageEl) { messageEl.textContent = "Submitting…"; messageEl.className = "auth-message"; }

    const submittedByName = getFormStaffName();
    const submittedById = getFormStaffId();

    try {
        const docDefinition = buildSubmissionPdfDocDefinition(record, result.answers, submittedByName);
        const blob = await pdfMake.createPdf(docDefinition).getBlob();

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
    } catch (error) {
        console.error("Failed to submit form:", error);
        if (messageEl) {
            messageEl.textContent = "Something went wrong submitting this form. Please try again.";
            messageEl.className = "auth-message error";
        }
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Submit"; }
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
            const row = document.createElement("div");
            row.className = "notification-item";
            row.innerHTML = `
                <strong>${formEscapeHtml(submission.submitted_by_name || "Staff")}</strong>
                <p>${formEscapeHtml(formatFormDate(submission.created_at))}</p>
            `;
            const viewBtn = document.createElement("button");
            viewBtn.type = "button";
            viewBtn.className = "workbook-btn workbook-btn--preview";
            viewBtn.style.marginTop = "8px";
            viewBtn.textContent = "View PDF";
            viewBtn.addEventListener("click", () => viewFormSubmission(submission));
            row.appendChild(viewBtn);
            listEl.appendChild(row);
        });
    }
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
