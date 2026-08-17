/* ===========================================================
   PROJECT FILES — "All Files" (project-files.html)

   A single project-scoped index (public.project_files) of every document
   filed under the fixed 11-category folder taxonomy
   (window.ProjectFields.PROJECT_FILE_CATEGORIES — single source of truth,
   also used by form-builder.js's "file into a project folder?" pickers).
   Two ways a row gets here:
     - source = 'upload'          — a plain file, uploaded directly on this
       page, stored in the project-documents bucket (same bucket/path
       convention/RLS as every other project file — see uploadFile() below).
     - source = 'form_submission' — a form template with a folder mapping
       (default_category/default_subfolder) was filled out; the matching
       project_files row is created automatically by a database trigger
       (file_form_submission() — see SQL FILES/
       supabase-project-files-schema.sql) the moment the submission is
       inserted. This page never writes those rows itself, only reads them.

   Waits for "project-shell:ready" (project-shell.js) to know which project
   we're on, same as every other project-*.html page.
=========================================================== */

(function () {
    "use strict";

    const PROJECT_FILES_TABLE = "project_files";
    const FORM_TEMPLATES_TABLE = "form_templates";
    const PROJECT_DOCS_BUCKET = "project-documents";
    const FORM_SUBMISSIONS_BUCKET = "form-submissions";

    let currentProject = null;
    let myProjectRole = null;        // via project_role() RPC — gates the Delete button the same way the RLS policy does
    let allFiles = [];               // project_files rows for this project, every folder
    let projectForms = [];           // form_templates rows with a folder mapping (default_category/default_subfolder set)
    let selectedCategory = null;
    let selectedSubfolder = null;
    let expandedCategory = null;     // which category's subfolder list is open in the tree (List view)
    let currentView = "list";        // "list" | "folders" — two ways to browse to the same folder
    let folderBrowseCategory = null; // Folders view drill state: null = showing the 11 category tiles, else showing that category's subfolder tiles
    let pendingDeleteFile = null;

    /* ---------- helpers ---------- */

    function escapeHtmlFiles(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function getFilesStaffProfile() {
        return window.currentSupabaseProfile
            || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    }

    function getFilesStaffName() {
        const profile = getFilesStaffProfile();
        return (profile && (profile.full_name || profile.username)) || "Staff";
    }

    function getFilesStaffId() {
        const profile = getFilesStaffProfile();
        return profile?.id || profile?.uid || null;
    }

    function setFilesPageMessage(text, type) {
        const el = document.getElementById("filesPageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; return; }
        el.textContent = text;
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = "block";
        if (type === "success") setTimeout(() => { el.style.display = "none"; }, 4000);
    }

    function formatFileDate(isoString) {
        try {
            return new Date(isoString).toLocaleString(undefined, {
                month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
            });
        } catch {
            return isoString;
        }
    }

    function canManageFiles() {
        return myProjectRole === "project_admin" || myProjectRole === "project_manager";
    }

    function canDeleteFile(file) {
        return canManageFiles() || String(file.uploaded_by) === String(getFilesStaffId());
    }

    /* ---------- load ---------- */

    async function loadMyProjectRole(projectId) {
        const { data, error } = await window.supabaseClient.rpc("project_role", { p_project_id: projectId });
        if (error) { console.error("Failed to resolve project role:", error); myProjectRole = null; return; }
        myProjectRole = data;
    }

    async function loadFiles(projectId) {
        // form_submissions(form_title) rides along via the form_submission_id
        // foreign key, purely so a form-filed row's badge can say
        // "Form: <template title>" without a second query per row.
        const { data, error } = await window.supabaseClient
            .from(PROJECT_FILES_TABLE)
            .select("*, form_submissions(form_title)")
            .eq("project_id", projectId)
            .order("created_at", { ascending: false });

        if (error) {
            console.error("Failed to load project files:", error);
            setFilesPageMessage("Couldn't load this project's files. Please try again.", "error");
            allFiles = [];
            return;
        }

        allFiles = data || [];
    }

    async function loadProjectForms() {
        const { data, error } = await window.supabaseClient
            .from(FORM_TEMPLATES_TABLE)
            .select("id, title, default_category, default_subfolder")
            .not("default_category", "is", null)
            .not("default_subfolder", "is", null);

        if (error) {
            console.error("Failed to load project-mapped form templates:", error);
            projectForms = [];
            return;
        }

        projectForms = data || [];
    }

    /* ---------- folder tree (left) ---------- */

    function filesInFolder(categoryKey, subfolderKey) {
        return allFiles.filter(f => f.category === categoryKey && f.subfolder === subfolderKey);
    }

    function filesInCategory(categoryKey) {
        return allFiles.filter(f => f.category === categoryKey);
    }

    function renderTree() {
        const treeEl = document.getElementById("filesTree");
        if (!treeEl) return;

        const categories = (window.ProjectFields && window.ProjectFields.PROJECT_FILE_CATEGORIES) || [];

        treeEl.innerHTML = categories.map(category => {
            const isExpanded = expandedCategory === category.key;
            const categoryCount = filesInCategory(category.key).length;

            const subfoldersHtml = category.subfolders.map(subfolder => {
                const isSelected = selectedCategory === category.key && selectedSubfolder === subfolder.key;
                const count = filesInFolder(category.key, subfolder.key).length;
                return `
                    <button type="button" class="all-files-subfolder-btn${isSelected ? " is-selected" : ""}"
                            data-category="${escapeHtmlFiles(category.key)}" data-subfolder="${escapeHtmlFiles(subfolder.key)}">
                        <span class="all-files-subfolder-label">${escapeHtmlFiles(subfolder.label)}</span>
                        <span class="all-files-folder-count${count ? "" : " all-files-folder-count--zero"}">${count}</span>
                    </button>
                `;
            }).join("");

            return `
                <div class="all-files-category${isExpanded ? " is-expanded" : ""}">
                    <button type="button" class="all-files-category-btn" data-category="${escapeHtmlFiles(category.key)}">
                        <span class="all-files-category-caret">${isExpanded ? "⌄" : "›"}</span>
                        <span class="all-files-category-label">${escapeHtmlFiles(category.number)} — ${escapeHtmlFiles(category.label)}</span>
                        <span class="all-files-folder-count${categoryCount ? "" : " all-files-folder-count--zero"}">${categoryCount}</span>
                    </button>
                    <div class="all-files-subfolder-list">${subfoldersHtml}</div>
                </div>
            `;
        }).join("");

        treeEl.querySelectorAll(".all-files-category-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const key = btn.dataset.category;
                expandedCategory = expandedCategory === key ? null : key;
                renderTree();
            });
        });

        treeEl.querySelectorAll(".all-files-subfolder-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                selectFolder(btn.dataset.category, btn.dataset.subfolder);
            });
        });
    }

    // Selecting a folder is shared by both views (the tree's subfolder
    // buttons and the Folders view's subfolder tiles both call this), so
    // List and Folders always agree on what's currently open.
    function selectFolder(categoryKey, subfolderKey) {
        selectedCategory = categoryKey;
        selectedSubfolder = subfolderKey;
        expandedCategory = categoryKey;
        folderBrowseCategory = categoryKey;
        render();
    }

    /* ---------- main panel (right) ---------- */

    function renderMainPanel() {
        const titleEl = document.getElementById("filesCurrentFolderTitle");
        const actionsEl = document.getElementById("filesFolderActions");
        const hintEl = document.getElementById("filesNoFolderHint");
        const emptyEl = document.getElementById("filesFolderEmpty");
        const listEl = document.getElementById("filesFolderList");
        if (!titleEl || !actionsEl || !listEl) return;

        if (!selectedCategory || !selectedSubfolder) {
            titleEl.textContent = "Select a folder";
            actionsEl.innerHTML = "";
            if (hintEl) hintEl.style.display = "block";
            if (emptyEl) emptyEl.style.display = "none";
            listEl.innerHTML = "";
            return;
        }

        if (hintEl) hintEl.style.display = "none";

        const category = window.ProjectFields.findFileCategory(selectedCategory);
        const subfolder = window.ProjectFields.findFileSubfolder(selectedCategory, selectedSubfolder);
        titleEl.textContent = category && subfolder ? `${category.label} / ${subfolder.label}` : "Folder";

        const matchingForms = projectForms.filter(f => f.default_category === selectedCategory && f.default_subfolder === selectedSubfolder);

        actionsEl.innerHTML = `
            <button type="button" class="workbook-btn workbook-btn--preview" id="filesUploadBtn">+ Upload file</button>
            ${matchingForms.map(f => `
                <a class="workbook-btn workbook-btn--edit" href="form-template.html?project=${encodeURIComponent(currentProject.id)}&template=${encodeURIComponent(f.id)}">+ Fill ${escapeHtmlFiles(f.title)}</a>
            `).join("")}
        `;

        document.getElementById("filesUploadBtn")?.addEventListener("click", () => {
            document.getElementById("filesUploadInput")?.click();
        });

        const files = filesInFolder(selectedCategory, selectedSubfolder);

        if (!files.length) {
            if (emptyEl) emptyEl.style.display = "block";
            listEl.innerHTML = "";
            return;
        }
        if (emptyEl) emptyEl.style.display = "none";

        listEl.innerHTML = files.map(file => {
            const isFormFiled = file.source === "form_submission";
            const badgeText = isFormFiled ? `Form: ${file.form_submissions?.form_title || "submission"}` : "Uploaded";
            const canDelete = canDeleteFile(file);

            return `
                <div class="record-row all-files-row" data-file-id="${file.id}">
                    <div class="record-row-summary" style="cursor:default;">
                        <div class="record-row-title">
                            <div class="record-row-title-main">${escapeHtmlFiles(file.file_name)}</div>
                            <div class="record-row-title-sub">
                                <span class="chip ${isFormFiled ? "chip--info" : "chip--muted"}">${escapeHtmlFiles(badgeText)}</span>
                                ${escapeHtmlFiles(file.uploaded_by_name || "Staff")} • ${escapeHtmlFiles(formatFileDate(file.created_at))}
                            </div>
                        </div>
                        <div class="record-row-actions" style="margin-top:0;">
                            <button type="button" class="workbook-btn workbook-btn--preview" data-action="open">Open</button>
                            ${canDelete ? `<button type="button" class="workbook-btn workbook-btn--danger" data-action="delete">Delete</button>` : ""}
                        </div>
                    </div>
                </div>
            `;
        }).join("");

        listEl.querySelectorAll(".all-files-row").forEach(row => {
            const file = files.find(f => String(f.id) === row.dataset.fileId);
            if (!file) return;
            row.querySelector('[data-action="open"]')?.addEventListener("click", () => openFile(file));
            row.querySelector('[data-action="delete"]')?.addEventListener("click", () => openDeleteFileConfirm(file));
        });
    }

    /* ---------- folder view (blue folder-icon tiles) ---------- */

    function folderIconTile({ key, label, count, onClick }) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "all-files-folder-tile";
        btn.dataset.key = key;
        btn.innerHTML = `
            <span class="all-files-folder-icon"></span>
            <span class="all-files-folder-tile-label">${escapeHtmlFiles(label)}</span>
            <span class="all-files-folder-count${count ? "" : " all-files-folder-count--zero"}">${count}</span>
        `;
        btn.addEventListener("click", onClick);
        return btn;
    }

    function renderFolderBreadcrumb() {
        const el = document.getElementById("filesFolderBreadcrumb");
        if (!el) return;

        const category = folderBrowseCategory ? window.ProjectFields.findFileCategory(folderBrowseCategory) : null;
        const subfolder = (category && selectedSubfolder && selectedCategory === folderBrowseCategory)
            ? window.ProjectFields.findFileSubfolder(folderBrowseCategory, selectedSubfolder)
            : null;

        const crumbs = [];
        crumbs.push(category
            ? `<button type="button" class="all-files-folder-breadcrumb-link" data-crumb="root">All Files</button>`
            : `<span class="all-files-folder-breadcrumb-current">All Files</span>`);

        if (category) {
            crumbs.push(`<span class="all-files-folder-breadcrumb-sep">/</span>`);
            crumbs.push(subfolder
                ? `<button type="button" class="all-files-folder-breadcrumb-link" data-crumb="category">${escapeHtmlFiles(category.label)}</button>`
                : `<span class="all-files-folder-breadcrumb-current">${escapeHtmlFiles(category.label)}</span>`);
        }

        if (subfolder) {
            crumbs.push(`<span class="all-files-folder-breadcrumb-sep">/</span>`);
            crumbs.push(`<span class="all-files-folder-breadcrumb-current">${escapeHtmlFiles(subfolder.label)}</span>`);
        }

        el.innerHTML = crumbs.join("");

        el.querySelector('[data-crumb="root"]')?.addEventListener("click", () => {
            folderBrowseCategory = null;
            selectedCategory = null;
            selectedSubfolder = null;
            render();
        });
        el.querySelector('[data-crumb="category"]')?.addEventListener("click", () => {
            selectedCategory = null;
            selectedSubfolder = null;
            render();
        });
    }

    // Renders whichever level of the Folders view is currently open — the
    // 11 category tiles, a category's subfolder tiles, or (once a subfolder
    // is picked) nothing here at all, since placeMainPanel() swaps in the
    // shared file-list panel instead.
    function renderFolderView() {
        const gridEl = document.getElementById("filesFolderGrid");
        if (!gridEl) return;

        renderFolderBreadcrumb();

        const categories = (window.ProjectFields && window.ProjectFields.PROJECT_FILE_CATEGORIES) || [];
        gridEl.innerHTML = "";

        const inFolder = Boolean(selectedCategory && selectedSubfolder);
        if (inFolder) return; // placeMainPanel() shows the file panel instead of this grid

        if (folderBrowseCategory) {
            const category = window.ProjectFields.findFileCategory(folderBrowseCategory);
            if (!category) { folderBrowseCategory = null; return renderFolderView(); }
            category.subfolders.forEach(subfolder => {
                gridEl.appendChild(folderIconTile({
                    key: subfolder.key,
                    label: subfolder.label,
                    count: filesInFolder(category.key, subfolder.key).length,
                    onClick: () => selectFolder(category.key, subfolder.key)
                }));
            });
        } else {
            categories.forEach(category => {
                gridEl.appendChild(folderIconTile({
                    key: category.key,
                    label: `${category.number} — ${category.label}`,
                    count: filesInCategory(category.key).length,
                    onClick: () => { folderBrowseCategory = category.key; render(); }
                }));
            });
        }
    }

    // Moves the single #filesMainPanel instance into whichever view is
    // active, and (in Folders view) toggles between the drill-down grid and
    // the panel depending on whether a subfolder is actually selected.
    function placeMainPanel() {
        const panel = document.getElementById("filesMainPanel");
        const listSlot = document.getElementById("filesListMainSlot");
        const folderSlot = document.getElementById("filesFolderMainSlot");
        const gridEl = document.getElementById("filesFolderGrid");
        if (!panel || !listSlot || !folderSlot) return;

        const inFolder = Boolean(selectedCategory && selectedSubfolder);

        if (currentView === "list") {
            listSlot.appendChild(panel);
            panel.style.display = "";
        } else {
            folderSlot.appendChild(panel);
            panel.style.display = inFolder ? "" : "none";
            if (gridEl) gridEl.style.display = inFolder ? "none" : "grid";
        }
    }

    function switchView(view) {
        currentView = view;
        document.querySelectorAll(".all-files-view-toggle-btn").forEach(btn => {
            btn.classList.toggle("is-active", btn.dataset.view === view);
        });
        const listViewEl = document.getElementById("filesListView");
        const folderViewEl = document.getElementById("filesFolderView");
        if (listViewEl) listViewEl.style.display = view === "list" ? "flex" : "none";
        if (folderViewEl) folderViewEl.style.display = view === "folders" ? "block" : "none";
        render();
    }

    function render() {
        renderTree();
        renderMainPanel();
        renderFolderView();
        placeMainPanel();
    }

    /* ---------- open / upload / delete ---------- */

    async function openFile(file) {
        const bucket = file.bucket === FORM_SUBMISSIONS_BUCKET ? FORM_SUBMISSIONS_BUCKET : PROJECT_DOCS_BUCKET;

        const { data, error } = await window.supabaseClient
            .storage
            .from(bucket)
            .createSignedUrl(file.storage_path, 60 * 5);

        if (error || !data?.signedUrl) {
            console.error("Failed to create signed URL for file:", error);
            setFilesPageMessage("Couldn't open that file. Please try again.", "error");
            return;
        }

        window.open(data.signedUrl, "_blank", "noopener");
    }

    async function handleUploadInputChange(event) {
        const file = event.target.files && event.target.files[0];
        event.target.value = "";
        if (!file || !currentProject || !selectedCategory || !selectedSubfolder) return;

        setFilesPageMessage("Uploading…", "");

        try {
            const path = await window.ProjectFields.uploadFile(currentProject.id, file, null, {
                pathSegments: [selectedCategory, selectedSubfolder]
            });

            const { data: inserted, error } = await window.supabaseClient
                .from(PROJECT_FILES_TABLE)
                .insert({
                    project_id: currentProject.id,
                    category: selectedCategory,
                    subfolder: selectedSubfolder,
                    bucket: PROJECT_DOCS_BUCKET,
                    storage_path: path,
                    file_name: file.name,
                    source: "upload",
                    uploaded_by_name: getFilesStaffName()
                })
                .select("*, form_submissions(form_title)")
                .single();

            if (error) throw error;

            allFiles.unshift(inserted);
            render();
            setFilesPageMessage(`"${file.name}" was uploaded.`, "success");
        } catch (error) {
            console.error("Failed to upload file:", error);
            setFilesPageMessage("Something went wrong uploading that file. Please try again.", "error");
        }
    }

    function openDeleteFileConfirm(file) {
        pendingDeleteFile = file;
        const messageEl = document.getElementById("deleteFileConfirmMessage");
        if (messageEl) messageEl.textContent = "";
        document.getElementById("deleteFileConfirmOverlay")?.classList.remove("hidden");
    }

    function closeDeleteFileConfirm() {
        document.getElementById("deleteFileConfirmOverlay")?.classList.add("hidden");
        pendingDeleteFile = null;
    }

    async function confirmDeleteFile() {
        if (!pendingDeleteFile) return;
        const file = pendingDeleteFile;
        const messageEl = document.getElementById("deleteFileConfirmMessage");
        const confirmBtn = document.getElementById("confirmDeleteFileBtn");

        if (confirmBtn) confirmBtn.disabled = true;
        if (messageEl) { messageEl.textContent = "Deleting…"; messageEl.className = "auth-message"; }

        try {
            const { error } = await window.supabaseClient
                .from(PROJECT_FILES_TABLE)
                .delete()
                .eq("id", file.id);
            if (error) throw error;

            // Best-effort — the project_files row (what actually makes the
            // file discoverable/RLS-gated) is already gone either way.
            const bucket = file.bucket === FORM_SUBMISSIONS_BUCKET ? FORM_SUBMISSIONS_BUCKET : PROJECT_DOCS_BUCKET;
            window.supabaseClient.storage.from(bucket).remove([file.storage_path])
                .catch(err => console.warn("Couldn't remove file from storage:", err));

            allFiles = allFiles.filter(f => f.id !== file.id);
            closeDeleteFileConfirm();
            render();
            setFilesPageMessage("File deleted.", "success");
        } catch (error) {
            console.error("Failed to delete file:", error);
            if (messageEl) { messageEl.textContent = "Something went wrong deleting this file. Please try again."; messageEl.className = "auth-message error"; }
        } finally {
            if (confirmBtn) confirmBtn.disabled = false;
        }
    }

    /* ---------- wire up ---------- */

    document.getElementById("filesUploadInput")?.addEventListener("change", handleUploadInputChange);
    document.getElementById("cancelDeleteFileBtn")?.addEventListener("click", closeDeleteFileConfirm);
    document.getElementById("confirmDeleteFileBtn")?.addEventListener("click", confirmDeleteFile);
    document.getElementById("deleteFileConfirmOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeDeleteFileConfirm();
    });

    document.querySelectorAll(".all-files-view-toggle-btn").forEach(btn => {
        btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;
        currentProject = project;

        if (error || !project) {
            setFilesPageMessage("No project selected. Pick one from Project Overview.", "error");
            document.getElementById("filesLoadingState").style.display = "none";
            return;
        }

        await Promise.all([
            loadMyProjectRole(project.id),
            loadFiles(project.id),
            loadProjectForms()
        ]);

        document.getElementById("filesLoadingState").style.display = "none";
        document.getElementById("filesBody").style.display = "block";

        render();
    });

})();
