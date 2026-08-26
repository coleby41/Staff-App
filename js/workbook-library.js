/* ===========================
   EXCEL WORKBOOK LIBRARY
   Requires: window.supabaseClient (supabase-auth.js), XLSX (SheetJS)
=========================== */

const WORKBOOKS_BUCKET = "workbooks";
const WORKBOOKS_TABLE = "workbooks";

let workbookRecords = [];
let editingWorkbookRecord = null;

/* ---------- helpers ---------- */

function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
}

function formatUploadDate(isoString) {
    try {
        const date = new Date(isoString);
        return date.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit"
        });
    } catch {
        return isoString;
    }
}

function getCurrentStaffName() {
    const profile =
        window.currentSupabaseProfile ||
        JSON.parse(localStorage.getItem("staffProfile") || "null");

    return (profile && (profile.full_name || profile.username)) || "Staff";
}

function fileExtension(fileName) {
    const parts = fileName.split(".");
    return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

// Supabase Storage rejects object keys containing spaces, unicode, or other
// "unsafe" characters (e.g. Mac screenshot names like
// "Screenshot 2026-07-27 at 2.54.57 PM.png", which include a narrow
// no-break space before "PM") with a 400 "Invalid key" error. Build storage
// paths from a sanitized version of the filename; the original filename is
// kept separately (workbooks.file_name) for display/download.
function sanitizeForStorageKey(fileName) {
    const lastDot = fileName.lastIndexOf(".");
    const base = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
    const ext = lastDot > 0 ? fileName.slice(lastDot + 1) : "";

    const safeBase = base
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")    // strip accents (post-normalize diacritic marks)
        .replace(/[^\w.-]+/g, "-")          // anything not a-z/0-9/_/./- becomes "-"
        .replace(/-+/g, "-")                // collapse repeated dashes
        .replace(/^-+|-+$/g, "")            // trim leading/trailing dashes
        || "file";

    const safeExt = ext.replace(/[^\w]+/g, "").toLowerCase();

    return safeExt ? `${safeBase}.${safeExt}` : safeBase;
}

function showPageMessage(text, type) {
    const el = document.getElementById("workbookMessage");
    if (!el) return;
    el.textContent = text;
    el.className = `workbook-page-message ${type || ""}`;
    el.style.display = "block";
    if (type === "success") {
        setTimeout(() => { el.style.display = "none"; }, 4000);
    }
}

/* ---------- loading + rendering ---------- */

async function loadWorkbooks() {
    const loadingEl = document.getElementById("workbookLoadingState");
    const emptyEl = document.getElementById("workbookEmptyState");
    const gridEl = document.getElementById("workbookGrid");

    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        if (loadingEl) loadingEl.style.display = "none";
        showPageMessage("Couldn't connect to Supabase. Please refresh the page.", "error");
        return;
    }

    if (loadingEl) loadingEl.style.display = "block";
    if (emptyEl) emptyEl.style.display = "none";

    const { data, error } = await window.supabaseClient
        .from(WORKBOOKS_TABLE)
        .select("*")
        .order("created_at", { ascending: false });

    if (loadingEl) loadingEl.style.display = "none";

    if (error) {
        console.error("Failed to load workbooks:", error);
        showPageMessage("Couldn't load the workbook library. Please try again.", "error");
        return;
    }

    workbookRecords = data || [];
    renderWorkbookGrid();
}

function renderWorkbookGrid() {
    const gridEl = document.getElementById("workbookGrid");
    const emptyEl = document.getElementById("workbookEmptyState");
    if (!gridEl) return;

    gridEl.innerHTML = "";

    if (workbookRecords.length === 0) {
        if (emptyEl) emptyEl.style.display = "block";
        return;
    }
    if (emptyEl) emptyEl.style.display = "none";

    workbookRecords.forEach(record => {
        gridEl.appendChild(buildWorkbookCard(record));
    });
}

function prependWorkbookCard(record) {
    workbookRecords.unshift(record);
    const emptyEl = document.getElementById("workbookEmptyState");
    if (emptyEl) emptyEl.style.display = "none";

    const gridEl = document.getElementById("workbookGrid");
    if (!gridEl) return;
    gridEl.insertBefore(buildWorkbookCard(record), gridEl.firstChild);
}

function buildWorkbookCard(record) {
    const card = document.createElement("article");
    card.className = "workbook-card";
    card.dataset.id = record.id;

    card.innerHTML = `
        <div class="workbook-cover" style="background-image:url('${escapeHtml(record.cover_url)}')">
            <div class="workbook-cover-gradient"></div>
            <button type="button" class="workbook-edit-btn" data-action="edit" aria-label="Edit workbook">
                <span class="company-edit-icon"></span>
            </button>
            <h3 class="workbook-cover-title">${escapeHtml(record.title)}</h3>
        </div>
        <div class="workbook-card-body">
            <div class="workbook-meta">
                <span class="workbook-meta-uploader">${escapeHtml(record.uploaded_by)}</span>
                <span class="workbook-meta-date">${escapeHtml(formatUploadDate(record.created_at))}</span>
            </div>
            <div class="workbook-actions">
                <button type="button" class="workbook-btn workbook-btn--preview" data-action="preview">Preview</button>
                <a class="workbook-btn workbook-btn--download" data-action="download" href="${escapeHtml(record.file_url)}" download="${escapeHtml(record.file_name)}">Download</a>
            </div>
        </div>
    `;

    card.querySelector('[data-action="preview"]').addEventListener("click", () => {
        openPreviewModal(record);
    });

    card.querySelector('[data-action="edit"]').addEventListener("click", (e) => {
        e.stopPropagation();
        openEditWorkbookModal(record);
    });

    return card;
}

/* ---------- upload / edit modal ---------- */

function openUploadModal() {
    openWorkbookModal(null);
}

function openEditWorkbookModal(record) {
    openWorkbookModal(record);
}

function openWorkbookModal(record) {
    const overlay = document.getElementById("uploadModalOverlay");
    const titleEl = document.getElementById("workbookModalTitle");
    const subtitleEl = document.getElementById("workbookModalSubtitle");
    const uploaderInput = document.getElementById("workbookUploaderInput");
    const titleInput = document.getElementById("workbookTitleInput");
    const idInput = document.getElementById("workbookIdInput");
    const coverInput = document.getElementById("workbookCoverInput");
    const fileInput = document.getElementById("workbookFileInput");
    const coverExistingNote = document.getElementById("workbookCoverExistingNote");
    const fileExistingNote = document.getElementById("workbookFileExistingNote");
    const messageEl = document.getElementById("uploadFormMessage");
    const submitBtn = document.getElementById("submitUploadBtn");
    const previewWrap = document.getElementById("coverPreviewWrap");
    const deleteBtn = document.getElementById("deleteWorkbookBtn");

    editingWorkbookRecord = record || null;

    document.getElementById("uploadWorkbookForm")?.reset();
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }
    if (previewWrap) previewWrap.style.display = "none";

    if (record) {
        if (titleEl) titleEl.textContent = "Edit Workbook";
        if (subtitleEl) subtitleEl.textContent = "Update the workbook's details, or delete it below.";
        if (idInput) idInput.value = record.id;
        if (titleInput) titleInput.value = record.title || "";
        if (uploaderInput) uploaderInput.value = record.uploaded_by || getCurrentStaffName();
        if (coverInput) coverInput.required = false;
        if (fileInput) fileInput.required = false;
        if (coverExistingNote) coverExistingNote.style.display = "block";
        if (fileExistingNote) fileExistingNote.style.display = "block";
        if (submitBtn) submitBtn.textContent = "Save changes";
        if (deleteBtn) deleteBtn.style.display = "block";
    } else {
        if (titleEl) titleEl.textContent = "Add Workbook";
        if (subtitleEl) subtitleEl.textContent = "Upload a cover image and the Excel file. Everything else is filled in automatically.";
        if (idInput) idInput.value = "";
        if (uploaderInput) uploaderInput.value = getCurrentStaffName();
        if (coverInput) coverInput.required = true;
        if (fileInput) fileInput.required = true;
        if (coverExistingNote) coverExistingNote.style.display = "none";
        if (fileExistingNote) fileExistingNote.style.display = "none";
        if (submitBtn) submitBtn.textContent = "Upload workbook";
        if (deleteBtn) deleteBtn.style.display = "none";
    }

    overlay?.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeUploadModal() {
    document.getElementById("uploadModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
}

/* ---------- delete ---------- */

// Typing the workbook's own title to confirm (same pattern used for project
// deletion) -- cheap insurance against a one-click delete landing on the
// wrong workbook, which is otherwise unrecoverable.
function deleteWorkbookConfirmNameMatches() {
    const expected = (editingWorkbookRecord && editingWorkbookRecord.title) || "";
    const typed = document.getElementById("deleteWorkbookConfirmNameInput").value;
    return expected.length > 0 && typed.trim() === expected;
}

function deleteWorkbookConfirmReady() {
    return deleteWorkbookConfirmNameMatches()
        && document.getElementById("deleteWorkbookConfirmUnderstandCheckbox").checked;
}

function updateDeleteWorkbookConfirmBtnState() {
    document.getElementById("confirmDeleteWorkbookBtn").disabled = !deleteWorkbookConfirmReady();
}

function openDeleteWorkbookConfirm() {
    if (!editingWorkbookRecord) return;

    const name = editingWorkbookRecord.title || "this workbook";
    document.getElementById("deleteWorkbookConfirmName").textContent = name;
    const input = document.getElementById("deleteWorkbookConfirmNameInput");
    input.value = "";
    document.getElementById("deleteWorkbookConfirmUnderstandCheckbox").checked = false;

    const messageEl = document.getElementById("deleteWorkbookConfirmMessage");
    if (messageEl) messageEl.textContent = "";

    document.getElementById("deleteWorkbookConfirmOverlay")?.classList.remove("hidden");
    updateDeleteWorkbookConfirmBtnState();
    input.focus();
}

function closeDeleteWorkbookConfirm() {
    document.getElementById("deleteWorkbookConfirmOverlay")?.classList.add("hidden");
}

function removeWorkbookCardFromDom(id) {
    const gridEl = document.getElementById("workbookGrid");
    gridEl?.querySelector(`[data-id="${id}"]`)?.remove();

    workbookRecords = workbookRecords.filter(r => r.id !== id);

    if (workbookRecords.length === 0) {
        const emptyEl = document.getElementById("workbookEmptyState");
        if (emptyEl) emptyEl.style.display = "block";
    }
}

async function confirmDeleteWorkbook() {
    if (!editingWorkbookRecord) return;
    if (!deleteWorkbookConfirmReady()) return;

    const record = editingWorkbookRecord;
    const confirmBtn = document.getElementById("confirmDeleteWorkbookBtn");
    const messageEl = document.getElementById("deleteWorkbookConfirmMessage");

    if (confirmBtn) confirmBtn.disabled = true;

    try {
        const { error } = await window.supabaseClient
            .from(WORKBOOKS_TABLE)
            .delete()
            .eq("id", record.id);

        if (error) throw error;

        const pathsToRemove = [record.cover_path, record.file_path].filter(Boolean);
        if (pathsToRemove.length) {
            window.supabaseClient
                .storage
                .from(WORKBOOKS_BUCKET)
                .remove(pathsToRemove)
                .catch(err => console.warn("Couldn't remove workbook files:", err));
        }

        removeWorkbookCardFromDom(record.id);
        closeDeleteWorkbookConfirm();
        closeUploadModal();
        showPageMessage(`"${record.title}" was deleted.`, "success");

    } catch (error) {
        console.error("Failed to delete workbook:", error);
        if (messageEl) messageEl.textContent = "Something went wrong deleting this workbook. Please try again.";
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

function setUploadSubmitting(isSubmitting) {
    const btn = document.getElementById("submitUploadBtn");
    if (!btn) return;
    const isEditing = Boolean(document.getElementById("workbookIdInput")?.value);
    btn.disabled = isSubmitting;
    if (isSubmitting) {
        btn.textContent = isEditing ? "Saving…" : "Uploading…";
    } else {
        btn.textContent = isEditing ? "Save changes" : "Upload workbook";
    }
}

function replaceWorkbookCard(updated) {
    const index = workbookRecords.findIndex(r => r.id === updated.id);
    if (index !== -1) workbookRecords[index] = updated;

    const gridEl = document.getElementById("workbookGrid");
    const oldCard = gridEl?.querySelector(`[data-id="${updated.id}"]`);
    const newCard = buildWorkbookCard(updated);

    if (oldCard) {
        oldCard.replaceWith(newCard);
    } else if (gridEl) {
        gridEl.appendChild(newCard);
    }
}

async function handleUploadSubmit(event) {
    event.preventDefault();

    const idInput = document.getElementById("workbookIdInput");
    const titleInput = document.getElementById("workbookTitleInput");
    const uploaderInput = document.getElementById("workbookUploaderInput");
    const coverInput = document.getElementById("workbookCoverInput");
    const fileInput = document.getElementById("workbookFileInput");
    const messageEl = document.getElementById("uploadFormMessage");

    const editingId = idInput?.value || "";
    const isEditing = Boolean(editingId);

    const title = titleInput?.value.trim();
    const uploadedBy = uploaderInput?.value.trim();
    const coverFile = coverInput?.files?.[0];
    const workbookFile = fileInput?.files?.[0];

    const missingRequiredField = isEditing
        ? (!title || !uploadedBy)
        : (!title || !uploadedBy || !coverFile || !workbookFile);

    if (missingRequiredField) {
        if (messageEl) {
            messageEl.textContent = "Please fill in every field before saving.";
            messageEl.className = "auth-message error";
        }
        return;
    }

    if (workbookFile && !["xlsx", "xls", "xlsm"].includes(fileExtension(workbookFile.name))) {
        if (messageEl) {
            messageEl.textContent = "Please choose a .xlsx, .xls, or .xlsm file.";
            messageEl.className = "auth-message error";
        }
        return;
    }

    if (!window.supabaseClient) {
        if (messageEl) {
            messageEl.textContent = "Couldn't connect to Supabase. Please refresh and try again.";
            messageEl.className = "auth-message error";
        }
        return;
    }

    setUploadSubmitting(true);
    if (messageEl) {
        messageEl.textContent = isEditing ? "Saving…" : "Uploading…";
        messageEl.className = "auth-message";
    }

    try {
        const id = editingId || crypto.randomUUID();

        const payload = { title, uploaded_by: uploadedBy };

        if (coverFile) {
            const coverPath = `covers/${id}-${sanitizeForStorageKey(coverFile.name)}`;
            const { error: coverUploadError } = await window.supabaseClient
                .storage
                .from(WORKBOOKS_BUCKET)
                .upload(coverPath, coverFile, { cacheControl: "3600", upsert: false });
            if (coverUploadError) throw coverUploadError;

            payload.cover_path = coverPath;
            payload.cover_url = window.supabaseClient.storage.from(WORKBOOKS_BUCKET).getPublicUrl(coverPath).data.publicUrl;
        } else if (!isEditing) {
            throw new Error("Cover image is required.");
        }

        if (workbookFile) {
            const filePath = `files/${id}-${sanitizeForStorageKey(workbookFile.name)}`;
            const { error: fileUploadError } = await window.supabaseClient
                .storage
                .from(WORKBOOKS_BUCKET)
                .upload(filePath, workbookFile, { cacheControl: "3600", upsert: false });
            if (fileUploadError) throw fileUploadError;

            payload.file_name = workbookFile.name;
            payload.file_path = filePath;
            payload.file_url = window.supabaseClient.storage.from(WORKBOOKS_BUCKET).getPublicUrl(filePath).data.publicUrl;
        } else if (!isEditing) {
            throw new Error("Workbook file is required.");
        }

        if (isEditing) {
            const { data: updated, error: updateError } = await window.supabaseClient
                .from(WORKBOOKS_TABLE)
                .update(payload)
                .eq("id", id)
                .select()
                .single();

            if (updateError) throw updateError;

            replaceWorkbookCard(updated);
            closeUploadModal();
            showPageMessage(`"${title}" was updated.`, "success");
        } else {
            const { data: inserted, error: insertError } = await window.supabaseClient
                .from(WORKBOOKS_TABLE)
                .insert({ id, ...payload })
                .select()
                .single();

            if (insertError) throw insertError;

            prependWorkbookCard(inserted);
            closeUploadModal();
            showPageMessage(`"${title}" was uploaded successfully.`, "success");
        }

    } catch (error) {
        console.error("Workbook save failed:", error);
        if (messageEl) {
            messageEl.textContent = isEditing ? "Couldn't save changes. Please try again." : "Upload failed. Please try again.";
            messageEl.className = "auth-message error";
        }
    } finally {
        setUploadSubmitting(false);
    }
}

function handleCoverInputChange(event) {
    const file = event.target.files?.[0];
    const wrap = document.getElementById("coverPreviewWrap");
    const img = document.getElementById("coverPreviewImg");
    if (!file || !wrap || !img) {
        if (wrap) wrap.style.display = "none";
        return;
    }
    img.src = URL.createObjectURL(file);
    wrap.style.display = "block";
}

/* ---------- preview modal (SheetJS) ---------- */

async function openPreviewModal(record) {
    const overlay = document.getElementById("previewModalOverlay");
    const titleEl = document.getElementById("previewModalTitle");
    const subtitleEl = document.getElementById("previewModalSubtitle");
    const bodyEl = document.getElementById("previewModalBody");

    if (titleEl) titleEl.textContent = record.title;
    if (subtitleEl) subtitleEl.textContent = `Uploaded by ${record.uploaded_by} · ${formatUploadDate(record.created_at)}`;
    if (bodyEl) bodyEl.innerHTML = `<p class="workbook-preview-loading">Loading preview…</p>`;

    overlay?.classList.remove("hidden");
    document.body.classList.add("popup-active");

    try {
        const response = await fetch(record.file_url);
        if (!response.ok) throw new Error("Could not fetch file");
        const arrayBuffer = await response.arrayBuffer();

        const workbook = XLSX.read(arrayBuffer, { type: "array" });
        const sheetNames = workbook.SheetNames;

        if (sheetNames.length === 0) {
            bodyEl.innerHTML = `<p class="workbook-preview-empty">This workbook has no sheets to preview.</p>`;
            return;
        }

        renderSheetTabs(workbook, sheetNames);

    } catch (error) {
        console.error("Preview failed:", error);
        if (bodyEl) {
            bodyEl.innerHTML = `<p class="workbook-preview-empty">Couldn't generate a preview for this file. Try downloading it instead.</p>`;
        }
    }
}

function renderSheetTabs(workbook, sheetNames) {
    const bodyEl = document.getElementById("previewModalBody");
    if (!bodyEl) return;

    const tabsHtml = sheetNames
        .map((name, i) => `<button type="button" class="workbook-sheet-tab${i === 0 ? " active" : ""}" data-sheet="${escapeHtml(name)}">${escapeHtml(name)}</button>`)
        .join("");

    bodyEl.innerHTML = `
        ${sheetNames.length > 1 ? `<div class="workbook-sheet-tabs">${tabsHtml}</div>` : ""}
        <div class="workbook-sheet-table-wrap" id="workbookSheetTableWrap"></div>
    `;

    function renderSheet(name) {
        const wrap = document.getElementById("workbookSheetTableWrap");
        if (!wrap) return;
        const sheet = workbook.Sheets[name];
        const html = XLSX.utils.sheet_to_html(sheet, { editable: false });
        wrap.innerHTML = html;
        const table = wrap.querySelector("table");
        if (table) table.classList.add("workbook-sheet-table");
    }

    bodyEl.querySelectorAll(".workbook-sheet-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            bodyEl.querySelectorAll(".workbook-sheet-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            renderSheet(tab.dataset.sheet);
        });
    });

    renderSheet(sheetNames[0]);
}

function closePreviewModal() {
    document.getElementById("previewModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
}

/* ---------- wire up ---------- */

window.addEventListener("DOMContentLoaded", function () {
    loadWorkbooks();

    document.getElementById("addWorkbookBtn")?.addEventListener("click", openUploadModal);
    document.getElementById("cancelUploadBtn")?.addEventListener("click", closeUploadModal);
    document.getElementById("uploadWorkbookForm")?.addEventListener("submit", handleUploadSubmit);
    document.getElementById("workbookCoverInput")?.addEventListener("change", handleCoverInputChange);
    document.getElementById("closePreviewBtn")?.addEventListener("click", closePreviewModal);

    document.getElementById("deleteWorkbookBtn")?.addEventListener("click", openDeleteWorkbookConfirm);
    document.getElementById("cancelDeleteWorkbookBtn")?.addEventListener("click", closeDeleteWorkbookConfirm);
    document.getElementById("confirmDeleteWorkbookBtn")?.addEventListener("click", confirmDeleteWorkbook);

    document.getElementById("uploadModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeUploadModal();
    });
    document.getElementById("previewModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closePreviewModal();
    });
    document.getElementById("deleteWorkbookConfirmNameInput")?.addEventListener("input", updateDeleteWorkbookConfirmBtnState);
    document.getElementById("deleteWorkbookConfirmUnderstandCheckbox")?.addEventListener("change", updateDeleteWorkbookConfirmBtnState);
    document.getElementById("deleteWorkbookConfirmOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeDeleteWorkbookConfirm();
    });
});