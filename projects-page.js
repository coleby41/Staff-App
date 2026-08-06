/* ===========================================================
   PROJECT OVERVIEW PAGE (project-home.html)
   Reads/writes public.projects in Supabase (see
   SQL FILES/supabase-projects-setup.sql — must be run once before this
   page will load or save anything).

   Custom auth model: no auth.uid(), RLS is open to anon, access control
   is app-level. This page itself is gated by nav-access.js under the
   "project_overview" nav key — grant it to workgroups from the
   Workgroups admin page.

   Displays projects as a workbook-style card grid (same visual language
   as excel-workbook.html / venders.html) and drives the "+ New Project
   Onboard" wizard: 10 sections, every one skippable, with Back/Next/Skip
   and a Save & Finish Later option so partial progress is never lost.
=========================================================== */

// Field/section config now lives in project-fields.js (shared with the
// per-project dashboard pages) — make sure that script tag loads before
// this one.
const PROJECTS_TABLE = window.ProjectFields.PROJECTS_TABLE;
const PROJECT_DOCS_BUCKET = window.ProjectFields.PROJECT_DOCS_BUCKET;
const WIZARD_STEPS = window.ProjectFields.WIZARD_STEPS;

let allProjects = [];
let projectWizardState = null; // { id, stepIndex, values: {...}, pendingFiles: {} }

/* ===========================
   ADDRESS AUTOCOMPLETE (Mailing address, Step 1)
   Free, no API key: OpenStreetMap's Nominatim search API. Debounced to
   respect their ~1 request/second usage policy, and results carry the
   required "Search by OpenStreetMap" attribution.
=========================== */

let addressAutocompleteTimer = null;

// Wires up whichever field in the CURRENTLY VISIBLE step is flagged
// addressLookup (today just owner_address on Step 1). Safe to call on
// every render — no-op if no such field is on screen.
function attachAddressAutocomplete() {
    const state = projectWizardState;
    if (!state) return;

    const step = WIZARD_STEPS[state.stepIndex];
    const field = step.fields.find(f => f.addressLookup);
    if (!field) return;

    const input = document.querySelector(`#projectWizardStepBody input[name="${field.name}"]`);
    const dropdown = document.getElementById(`addressSuggestions-${field.name}`);
    if (!input || !dropdown) return;

    input.addEventListener("input", () => {
        clearTimeout(addressAutocompleteTimer);
        const query = input.value.trim();

        if (query.length < 4) {
            dropdown.classList.add("hidden");
            dropdown.innerHTML = "";
            return;
        }

        addressAutocompleteTimer = setTimeout(() => fetchAddressSuggestions(query, input, dropdown), 450);
    });

    input.addEventListener("focus", () => {
        if (dropdown.innerHTML.trim()) dropdown.classList.remove("hidden");
    });

    document.addEventListener("click", (event) => {
        if (!event.target.closest(".address-autocomplete-field") && !event.target.closest(".address-suggestions")) {
            dropdown.classList.add("hidden");
        }
    });
}

async function fetchAddressSuggestions(query, input, dropdown) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error(`Nominatim request failed: ${res.status}`);
        const results = await res.json();

        if (!results.length) {
            dropdown.classList.remove("hidden");
            dropdown.innerHTML = `<p class="address-suggestion-empty">No matches found.</p>`;
            return;
        }

        dropdown.classList.remove("hidden");
        dropdown.innerHTML = results.map(r => `
            <button type="button" class="address-suggestion-option" data-value="${escapeHtmlProject(r.display_name)}">
                ${escapeHtmlProject(r.display_name)}
            </button>
        `).join("") + `<p class="address-suggestion-attribution">Search by OpenStreetMap</p>`;

        dropdown.querySelectorAll(".address-suggestion-option").forEach(btn => {
            btn.addEventListener("click", () => {
                input.value = btn.dataset.value;
                if (projectWizardState) projectWizardState.values[input.name] = btn.dataset.value;
                dropdown.classList.add("hidden");
                dropdown.innerHTML = "";
            });
        });

    } catch (error) {
        console.warn("Address autocomplete failed:", error);
        dropdown.classList.add("hidden");
    }
}

/* ===========================
   HELPERS
=========================== */

function escapeHtmlProject(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
}

function isBlankProjectValue(value) {
    return window.ProjectFields.isBlank(value);
}

function currentStaffInfo() {
    const profile = window.currentSupabaseProfile
        || JSON.parse(localStorage.getItem("staffProfile") || "null");
    return {
        id: profile && (profile.id ?? profile.uid) != null ? String(profile.id ?? profile.uid) : null,
        name: (profile && (profile.full_name || profile.username)) || "Staff Portal"
    };
}

function setProjectPageMessage(text, type) {
    const el = document.getElementById("projectMessage");
    if (!el) return;
    if (!text) { el.style.display = "none"; return; }
    el.textContent = text;
    el.className = `workbook-page-message ${type || ""}`.trim();
    el.style.display = "block";
}

function setWizardMessage(text, type) {
    const el = document.getElementById("projectWizardMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `auth-message ${type || ""}`.trim();
}

function formatSiteAddress(project) {
    const line2 = [project.site_city, project.site_state].filter(Boolean).join(", ");
    const full = [line2, project.site_zip].filter(Boolean).join(" ");
    return [project.site_address, full].filter(Boolean).join(" · ");
}

// How many of the 10 sections have at least one field filled in — shown on
// the card so staff can see onboarding progress at a glance.
function computeProjectCompleteness(project) {
    return window.ProjectFields.computeCompleteness(project);
}

function anyProjectOverlayOpen() {
    return [
        "projectWizardModalOverlay",
        "deleteProjectConfirmOverlay"
    ].some(id => {
        const el = document.getElementById(id);
        return el && !el.classList.contains("hidden");
    });
}

/* ===========================
   LOAD + RENDER GRID
=========================== */

async function loadProjects() {
    const loadingState = document.getElementById("projectLoadingState");
    const emptyState = document.getElementById("projectEmptyState");
    const grid = document.getElementById("projectsGrid");

    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        return;
    }

    if (loadingState) loadingState.style.display = "block";
    if (emptyState) emptyState.style.display = "none";

    const { data, error } = await window.supabaseClient
        .from(PROJECTS_TABLE)
        .select("*")
        .order("name", { ascending: true });

    if (loadingState) loadingState.style.display = "none";

    if (error) {
        console.error("Failed to load projects:", error);
        setProjectPageMessage("Couldn't load projects. The projects table may not be set up yet — run SQL FILES/supabase-projects-setup.sql in Supabase, then refresh.", "error");
        return;
    }

    allProjects = data || [];

    if (allProjects.length === 0) {
        if (emptyState) emptyState.style.display = "block";
        if (grid) grid.innerHTML = "";
        return;
    }

    renderProjects(allProjects);
    applyProjectSearchFilter();
}

function renderProjects(projects) {
    const grid = document.getElementById("projectsGrid");
    if (!grid) return;

    grid.innerHTML = "";

    projects.forEach(project => {
        const { complete, total } = computeProjectCompleteness(project);
        const address = formatSiteAddress(project);

        const card = document.createElement("div");
        card.className = "workbook-card project-card";
        card.dataset.projectId = project.id;

        card.innerHTML = `
            <div class="company-card-body">

                <button
                    type="button"
                    class="company-edit-btn project-edit-btn"
                    data-id="${project.id}"
                    aria-label="Edit project">
                    <span class="company-edit-icon"></span>
                </button>

                <h3 class="company-card-name">${escapeHtmlProject(project.name || "Untitled project")}</h3>

                <div class="company-card-address">
                    ${address ? `<p>${escapeHtmlProject(address)}</p>` : `<p class="company-card-muted">No site address on file</p>`}
                </div>

                ${project.gc_name ? `
                <div class="company-card-row">
                    <span class="company-card-label">General Contractor</span>
                    <span class="company-card-value">${escapeHtmlProject(project.gc_name)}</span>
                </div>` : ""}

                <div class="company-card-row">
                    <span class="company-card-label">Onboarding</span>
                    <span class="chip ${complete === total ? "chip--success" : "chip--muted"}">${complete}/${total} sections</span>
                </div>

            </div>
        `;

        grid.appendChild(card);
    });

    grid.querySelectorAll(".project-card").forEach(card => {
        card.addEventListener("click", (event) => {
            if (event.target.closest(".project-edit-btn")) return;
            const id = card.dataset.projectId;
            if (id) window.location.href = `projects.html?id=${encodeURIComponent(id)}`;
        });
    });

    grid.querySelectorAll(".project-edit-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            const project = allProjects.find(p => String(p.id) === String(id));
            if (project) openProjectWizard(project);
        });
    });
}

/* ===========================
   SEARCH (mirrors excel-workbook.html's initWorkbookSearch)
=========================== */

function applyProjectSearchFilter() {
    const searchInput = document.getElementById("projectSearchInput");
    const grid = document.getElementById("projectsGrid");
    const noResultsState = document.getElementById("projectNoResultsState");
    if (!searchInput || !grid) return;

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

/* ===========================
   WIZARD — FIELD RENDERING
=========================== */

function wizardFieldHtml(field, state) {
    const value = state.values[field.name];

    if (field.type === "textarea") {
        return `
            <label class="auth-field">
                ${escapeHtmlProject(field.label)}
                <textarea name="${field.name}" placeholder="${escapeHtmlProject(field.placeholder || "")}" autocomplete="off" data-lpignore="true" data-1p-ignore autocorrect="off" spellcheck="false">${escapeHtmlProject(value || "")}</textarea>
            </label>
        `;
    }

    if (field.type === "select") {
        const options = field.options.map(opt =>
            `<option value="${escapeHtmlProject(opt)}" ${value === opt ? "selected" : ""}>${escapeHtmlProject(opt)}</option>`
        ).join("");
        return `
            <label class="auth-field">
                ${escapeHtmlProject(field.label)}
                <select name="${field.name}" autocomplete="off">
                    <option value="" ${!value ? "selected" : ""}>—</option>
                    ${options}
                </select>
            </label>
        `;
    }

    if (field.type === "file") {
        const existingPath = state.values[field.pathField];
        const pendingFile = state.pendingFiles[field.name];
        let note = "";
        if (pendingFile) {
            note = `<p class="wizard-file-existing-note">Selected: ${escapeHtmlProject(pendingFile.name)} (will upload on save)</p>`;
        } else if (existingPath) {
            const fileName = existingPath.split("/").pop();
            note = `<p class="wizard-file-existing-note">On file: ${escapeHtmlProject(fileName)} — <a href="#" class="wizard-view-file-link" data-path="${escapeHtmlProject(existingPath)}">view</a>. Choosing a new file replaces it.</p>`;
        }
        return `
            <label class="auth-field">
                ${escapeHtmlProject(field.label)}
                <input type="file" name="${field.name}" accept="${field.accept || ""}">
            </label>
            ${note}
        `;
    }

    // text / tel / email — autocomplete="off" plus a couple of extra
    // attributes Safari/iOS respects better than autocomplete alone
    // (data-lpignore/data-1p-ignore also happen to quiet 1Password/LastPass).
    const extraAttrs = [
        field.maxlength ? `maxlength="${field.maxlength}"` : "",
        field.uppercase ? `style="text-transform:uppercase;"` : ""
    ].filter(Boolean).join(" ");

    const noAutofillAttrs = `autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore`;

    if (field.addressLookup) {
        return `
            <label class="auth-field address-autocomplete-field">
                ${escapeHtmlProject(field.label)}
                <input type="text" name="${field.name}" value="${escapeHtmlProject(value || "")}" placeholder="${escapeHtmlProject(field.placeholder || "")}" ${noAutofillAttrs} ${extraAttrs}>
                <div class="address-suggestions hidden" id="addressSuggestions-${field.name}"></div>
            </label>
        `;
    }

    return `
        <label class="auth-field">
            ${escapeHtmlProject(field.label)}
            <input type="${field.type}" name="${field.name}" value="${escapeHtmlProject(value || "")}" placeholder="${escapeHtmlProject(field.placeholder || "")}" ${noAutofillAttrs} ${extraAttrs}>
        </label>
    `;
}

function renderWizardStep() {
    const state = projectWizardState;
    if (!state) return;

    const step = WIZARD_STEPS[state.stepIndex];
    const isFirst = state.stepIndex === 0;
    const isLast = state.stepIndex === WIZARD_STEPS.length - 1;

    document.getElementById("projectWizardTitle").textContent = state.id ? "Edit Project" : "New Project Onboarding";
    document.getElementById("projectWizardStepLabel").textContent = `Step ${state.stepIndex + 1} of ${WIZARD_STEPS.length}`;

    const bodyEl = document.getElementById("projectWizardStepBody");
    bodyEl.innerHTML = `
        <h3 class="wizard-step-title">${escapeHtmlProject(step.title)}</h3>
        ${step.hint ? `<p class="wizard-step-hint">${escapeHtmlProject(step.hint)}</p>` : ""}
        ${step.fields.map(field => wizardFieldHtml(field, state)).join("")}
    `;

    bodyEl.querySelectorAll(".wizard-view-file-link").forEach(link => {
        link.addEventListener("click", (event) => {
            event.preventDefault();
            viewProjectFile(link.dataset.path);
        });
    });

    attachAddressAutocomplete();

    // Progress dots
    const progressEl = document.getElementById("projectWizardProgress");
    progressEl.innerHTML = WIZARD_STEPS.map((_, i) => {
        const cls = i < state.stepIndex ? "is-complete" : (i === state.stepIndex ? "is-current" : "");
        return `<div class="wizard-progress-dot ${cls}"></div>`;
    }).join("");

    // Step 1: top-left link is "Cancel" (nothing to go back to yet).
    // Step 2+: it becomes "Go back" instead — Cancel only makes sense
    // before any progress has been made.
    document.getElementById("projectWizardCancelBtn").style.display = isFirst ? "" : "none";
    document.getElementById("projectWizardBackBtn").style.display = isFirst ? "none" : "";
    document.getElementById("projectWizardNextBtn").textContent = isLast ? "Finish" : "Next";
    document.getElementById("deleteProjectBtn").style.display = state.id ? "block" : "none";

    setWizardMessage("", "");
}

// Reads whatever's currently typed in #projectWizardStepBody into
// projectWizardState, WITHOUT advancing the step. Used by Back/Next/Save.
function collectCurrentStepInputs() {
    const state = projectWizardState;
    if (!state) return;

    const step = WIZARD_STEPS[state.stepIndex];
    const bodyEl = document.getElementById("projectWizardStepBody");

    step.fields.forEach(field => {
        if (field.type === "file") {
            const input = bodyEl.querySelector(`[name="${field.name}"]`);
            if (input && input.files && input.files.length) {
                state.pendingFiles[field.name] = input.files[0];
            }
            return;
        }

        const input = bodyEl.querySelector(`[name="${field.name}"]`);
        if (!input) return;

        let value = input.value.trim();
        if (field.uppercase) value = value.toUpperCase();
        state.values[field.name] = value || null;
    });
}

/* ===========================
   WIZARD — OPEN / CLOSE / NAVIGATE
=========================== */

function openProjectWizard(project) {
    const values = {};
    WIZARD_STEPS.forEach(step => {
        step.fields.forEach(field => {
            if (field.type === "file") {
                values[field.pathField] = project ? project[field.pathField] ?? null : null;
            } else {
                values[field.name] = project ? project[field.name] ?? null : null;
            }
        });
    });

    projectWizardState = {
        id: project ? project.id : null,
        stepIndex: 0,
        values,
        pendingFiles: {}
    };

    renderWizardStep();

    document.getElementById("projectWizardModalOverlay").classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeProjectWizard() {
    document.getElementById("projectWizardModalOverlay").classList.add("hidden");
    projectWizardState = null;
    if (!anyProjectOverlayOpen()) document.body.classList.remove("popup-active");
}

function wizardGoBack() {
    if (!projectWizardState || projectWizardState.stepIndex === 0) return;
    collectCurrentStepInputs();
    projectWizardState.stepIndex--;
    renderWizardStep();
}

function wizardSkipStep() {
    if (!projectWizardState) return;
    // Deliberately does NOT collect this step's inputs — "skip" discards
    // whatever's currently typed here rather than saving it.
    if (projectWizardState.stepIndex === WIZARD_STEPS.length - 1) {
        finishProjectWizard();
        return;
    }
    projectWizardState.stepIndex++;
    renderWizardStep();
}

function wizardGoNext() {
    if (!projectWizardState) return;
    collectCurrentStepInputs();
    if (projectWizardState.stepIndex === WIZARD_STEPS.length - 1) {
        finishProjectWizard();
        return;
    }
    projectWizardState.stepIndex++;
    renderWizardStep();
}

async function wizardSaveAndFinishLater() {
    if (!projectWizardState) return;
    collectCurrentStepInputs();
    await saveProjectFromWizard("Project saved. Pick up where you left off anytime from its card.");
}

async function finishProjectWizard() {
    await saveProjectFromWizard(projectWizardState.id ? "Project updated." : "Project created.");
}

/* ===========================
   WIZARD — SAVE (insert/update + file uploads)
=========================== */

async function uploadProjectFile(projectId, file, existingPath) {
    const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const path = `${projectId}/${Date.now()}-${safeName}`;

    const { error: uploadError } = await window.supabaseClient
        .storage
        .from(PROJECT_DOCS_BUCKET)
        .upload(path, file, { upsert: false });

    if (uploadError) throw uploadError;

    if (existingPath) {
        window.supabaseClient
            .storage
            .from(PROJECT_DOCS_BUCKET)
            .remove([existingPath])
            .catch(err => console.warn("Couldn't remove old project file:", err));
    }

    return path;
}

async function viewProjectFile(filePath) {
    if (!window.supabaseClient || !filePath) return;

    const { data, error } = await window.supabaseClient
        .storage
        .from(PROJECT_DOCS_BUCKET)
        .createSignedUrl(filePath, 60 * 5);

    if (error || !data?.signedUrl) {
        console.error("Failed to create signed URL for project file:", error);
        setWizardMessage("Couldn't open that file. Please try again.", "error");
        return;
    }

    window.open(data.signedUrl, "_blank", "noopener");
}

async function saveProjectFromWizard(successMessage) {
    const state = projectWizardState;
    if (!state) return;

    const nextBtn = document.getElementById("projectWizardNextBtn");
    const saveLaterBtn = document.getElementById("projectWizardSaveLaterBtn");
    [nextBtn, saveLaterBtn].forEach(btn => { if (btn) btn.disabled = true; });
    setWizardMessage("Saving…", "");

    try {
        const staff = currentStaffInfo();

        // Build the payload from every non-file column tracked by the wizard.
        const payload = { ...state.values };
        if (!payload.name) payload.name = "Untitled Project";

        let savedId = state.id;

        if (savedId) {
            const { error } = await window.supabaseClient
                .from(PROJECTS_TABLE)
                .update(payload)
                .eq("id", savedId);
            if (error) throw error;
        } else {
            payload.created_by_id = staff.id;
            payload.created_by_name = staff.name;
            const { data, error } = await window.supabaseClient
                .from(PROJECTS_TABLE)
                .insert(payload)
                .select()
                .single();
            if (error) throw error;
            savedId = data.id;
            state.id = savedId;
        }

        // Upload any newly-selected files, then patch just those columns.
        const fileUpdates = {};
        for (const step of WIZARD_STEPS) {
            for (const field of step.fields) {
                if (field.type !== "file") continue;
                const file = state.pendingFiles[field.name];
                if (!file) continue;
                const newPath = await uploadProjectFile(savedId, file, state.values[field.pathField]);
                fileUpdates[field.pathField] = newPath;
                state.values[field.pathField] = newPath;
            }
        }

        if (Object.keys(fileUpdates).length) {
            const { error } = await window.supabaseClient
                .from(PROJECTS_TABLE)
                .update(fileUpdates)
                .eq("id", savedId);
            if (error) throw error;
        }

        closeProjectWizard();
        setProjectPageMessage(successMessage, "success");
        await loadProjects();

    } catch (error) {
        console.error("Failed to save project:", error);
        setWizardMessage("Something went wrong saving this project. Please try again.", "error");
    } finally {
        [nextBtn, saveLaterBtn].forEach(btn => { if (btn) btn.disabled = false; });
    }
}

/* ===========================
   DELETE
=========================== */

function openDeleteProjectConfirm() {
    if (!projectWizardState || !projectWizardState.id) return;
    document.getElementById("deleteProjectConfirmMessage").textContent = "";
    document.getElementById("deleteProjectConfirmOverlay").classList.remove("hidden");
}

function closeDeleteProjectConfirm() {
    document.getElementById("deleteProjectConfirmOverlay").classList.add("hidden");
    if (!anyProjectOverlayOpen()) document.body.classList.remove("popup-active");
}

async function confirmDeleteProject() {
    if (!projectWizardState || !projectWizardState.id) return;

    const confirmBtn = document.getElementById("confirmDeleteProjectBtn");
    confirmBtn.disabled = true;

    try {
        const projectId = projectWizardState.id;
        const filesToRemove = WIZARD_STEPS
            .flatMap(step => step.fields)
            .filter(f => f.type === "file")
            .map(f => projectWizardState.values[f.pathField])
            .filter(Boolean);

        const { error } = await window.supabaseClient
            .from(PROJECTS_TABLE)
            .delete()
            .eq("id", projectId);

        if (error) throw error;

        if (filesToRemove.length) {
            window.supabaseClient.storage.from(PROJECT_DOCS_BUCKET).remove(filesToRemove)
                .catch(err => console.warn("Couldn't remove project files:", err));
        }

        closeDeleteProjectConfirm();
        closeProjectWizard();
        setProjectPageMessage("Project deleted.", "success");
        await loadProjects();

    } catch (error) {
        console.error("Failed to delete project:", error);
        document.getElementById("deleteProjectConfirmMessage").textContent = "Something went wrong deleting this project. Please try again.";
        document.getElementById("deleteProjectConfirmMessage").className = "auth-message error";
    } finally {
        confirmBtn.disabled = false;
    }
}

/* ===========================
   WIRE UP
=========================== */

document.addEventListener("DOMContentLoaded", () => {

    const addBtn = document.getElementById("addProjectBtn");
    if (addBtn) addBtn.addEventListener("click", () => openProjectWizard(null));

    const searchInput = document.getElementById("projectSearchInput");
    if (searchInput) searchInput.addEventListener("input", applyProjectSearchFilter);

    const cancelBtn = document.getElementById("projectWizardCancelBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", closeProjectWizard);

    const wizardOverlay = document.getElementById("projectWizardModalOverlay");
    if (wizardOverlay) {
        wizardOverlay.addEventListener("click", (event) => {
            if (event.target === wizardOverlay) closeProjectWizard();
        });
    }

    const backBtn = document.getElementById("projectWizardBackBtn");
    if (backBtn) backBtn.addEventListener("click", wizardGoBack);

    const skipBtn = document.getElementById("projectWizardSkipBtn");
    if (skipBtn) skipBtn.addEventListener("click", wizardSkipStep);

    const nextBtn = document.getElementById("projectWizardNextBtn");
    if (nextBtn) nextBtn.addEventListener("click", wizardGoNext);

    const saveLaterBtn = document.getElementById("projectWizardSaveLaterBtn");
    if (saveLaterBtn) saveLaterBtn.addEventListener("click", wizardSaveAndFinishLater);

    const deleteBtn = document.getElementById("deleteProjectBtn");
    if (deleteBtn) deleteBtn.addEventListener("click", openDeleteProjectConfirm);

    const cancelDeleteBtn = document.getElementById("cancelDeleteProjectBtn");
    if (cancelDeleteBtn) cancelDeleteBtn.addEventListener("click", closeDeleteProjectConfirm);

    const confirmDeleteBtn = document.getElementById("confirmDeleteProjectBtn");
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener("click", confirmDeleteProject);

    loadProjects().then(() => {
        // Deep link from projects.html's "Edit Project" button
        // (project-home.html?openWizard=ID) — open that project straight
        // into the edit wizard, then clean the URL so a refresh doesn't
        // reopen it.
        const openWizardId = new URLSearchParams(window.location.search).get("openWizard");
        if (!openWizardId) return;

        const project = allProjects.find(p => String(p.id) === String(openWizardId));
        if (project) openProjectWizard(project);

        const url = new URL(window.location.href);
        url.searchParams.delete("openWizard");
        window.history.replaceState({}, "", url);
    });
});
