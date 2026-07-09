/* ===========================
   EXCEL WORKBOOK LIBRARY
   Requires: window.supabaseClient (supabase-auth.js), XLSX (SheetJS)
=========================== */

const WORKBOOKS_BUCKET = "workbooks";
const WORKBOOKS_TABLE = "workbooks";

let workbookRecords = [];

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

    return card;
}

/* ---------- upload modal ---------- */

function openUploadModal() {
    const overlay = document.getElementById("uploadModalOverlay");
    const uploaderInput = document.getElementById("workbookUploaderInput");
    const messageEl = document.getElementById("uploadFormMessage");

    if (uploaderInput) uploaderInput.value = getCurrentStaffName();
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    document.getElementById("uploadWorkbookForm")?.reset();
    if (uploaderInput) uploaderInput.value = getCurrentStaffName();

    const previewWrap = document.getElementById("coverPreviewWrap");
    if (previewWrap) previewWrap.style.display = "none";

    overlay?.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeUploadModal() {
    document.getElementById("uploadModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
}

function setUploadSubmitting(isSubmitting) {
    const btn = document.getElementById("submitUploadBtn");
    if (!btn) return;
    btn.disabled = isSubmitting;
    btn.textContent = isSubmitting ? "Uploading…" : "Upload workbook";
}

async function handleUploadSubmit(event) {
    event.preventDefault();

    const titleInput = document.getElementById("workbookTitleInput");
    const uploaderInput = document.getElementById("workbookUploaderInput");
    const coverInput = document.getElementById("workbookCoverInput");
    const fileInput = document.getElementById("workbookFileInput");
    const messageEl = document.getElementById("uploadFormMessage");

    const title = titleInput?.value.trim();
    const uploadedBy = uploaderInput?.value.trim();
    const coverFile = coverInput?.files?.[0];
    const workbookFile = fileInput?.files?.[0];

    if (!title || !uploadedBy || !coverFile || !workbookFile) {
        if (messageEl) {
            messageEl.textContent = "Please fill in every field before uploading.";
            messageEl.className = "auth-message error";
        }
        return;
    }

    const allowedExt = ["xlsx", "xls", "xlsm"];
    if (!allowedExt.includes(fileExtension(workbookFile.name))) {
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
    if (messageEl) { messageEl.textContent = "Uploading…"; messageEl.className = "auth-message"; }

    try {
        const id = crypto.randomUUID();
        const coverPath = `covers/${id}-${coverFile.name}`;
        const filePath = `files/${id}-${workbookFile.name}`;

        const { error: coverUploadError } = await window.supabaseClient
            .storage
            .from(WORKBOOKS_BUCKET)
            .upload(coverPath, coverFile, { cacheControl: "3600", upsert: false });

        if (coverUploadError) throw coverUploadError;

        const { error: fileUploadError } = await window.supabaseClient
            .storage
            .from(WORKBOOKS_BUCKET)
            .upload(filePath, workbookFile, { cacheControl: "3600", upsert: false });

        if (fileUploadError) throw fileUploadError;

        const coverUrl = window.supabaseClient.storage.from(WORKBOOKS_BUCKET).getPublicUrl(coverPath).data.publicUrl;
        const fileUrl = window.supabaseClient.storage.from(WORKBOOKS_BUCKET).getPublicUrl(filePath).data.publicUrl;

        const { data: inserted, error: insertError } = await window.supabaseClient
            .from(WORKBOOKS_TABLE)
            .insert({
                id,
                title,
                uploaded_by: uploadedBy,
                file_name: workbookFile.name,
                cover_path: coverPath,
                cover_url: coverUrl,
                file_path: filePath,
                file_url: fileUrl
            })
            .select()
            .single();

        if (insertError) throw insertError;

        prependWorkbookCard(inserted);
        closeUploadModal();
        showPageMessage(`"${title}" was uploaded successfully.`, "success");

    } catch (error) {
        console.error("Workbook upload failed:", error);
        if (messageEl) {
            messageEl.textContent = "Upload failed. Please try again.";
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

    document.getElementById("uploadModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeUploadModal();
    });
    document.getElementById("previewModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closePreviewModal();
    });
});