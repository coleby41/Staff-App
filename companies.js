/* ===========================================================
   COMPANIES PAGE
   Reads/writes public."Companies" in Supabase.
   Custom auth model: no auth.uid(), RLS is open to anon,
   access control is app-level (see supabase-companies-setup.sql).
=========================================================== */

const COMPANIES_TABLE = "Companies";
const W9_BUCKET = "company-w9s";

let allCompanies = [];

/* ===========================
   HELPERS
=========================== */

function escapeHtmlCompanies(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
}

// Shows only the last 4 characters of SSN/FID on the card.
function maskSsnFid(value) {
    if (!value) return "—";
    const digitsOnly = String(value).replace(/[^0-9A-Za-z]/g, "");
    if (digitsOnly.length <= 4) return String(value);
    const last4 = digitsOnly.slice(-4);
    return `•••-••-${last4}`;
}

function formatAddress(company) {
    const cityStateZip = [company.City, company.State]
        .filter(Boolean)
        .join(", ");

    const line2 = [cityStateZip, company.Zip]
        .filter(Boolean)
        .join(" ");

    return {
        street: company.Street || "",
        line2: line2 || ""
    };
}

function showCompanyMessage(text, type) {
    const el = document.getElementById("companyMessage");
    if (!el) return;
    el.textContent = text;
    el.className = `workbook-page-message ${type}`;
    el.style.display = "block";
}

function hideCompanyMessage() {
    const el = document.getElementById("companyMessage");
    if (!el) return;
    el.style.display = "none";
}

function setFormMessage(text, type) {
    const el = document.getElementById("companyFormMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `auth-message ${type || ""}`.trim();
}

/* ===========================
   LOAD + RENDER
=========================== */

async function loadCompanies() {

    const loadingState = document.getElementById("companyLoadingState");
    const emptyState = document.getElementById("companyEmptyState");
    const grid = document.getElementById("companyGrid");

    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        return;
    }

    if (loadingState) loadingState.style.display = "block";
    if (emptyState) emptyState.style.display = "none";

    const { data, error } = await window.supabaseClient
        .from(COMPANIES_TABLE)
        .select("*")
        .order("Name", { ascending: true });

    if (loadingState) loadingState.style.display = "none";

    if (error) {
        console.error("Failed to load companies:", error);
        showCompanyMessage("Couldn't load companies. Please refresh and try again.", "error");
        return;
    }

    allCompanies = data || [];

    if (allCompanies.length === 0) {
        if (emptyState) emptyState.style.display = "block";
        if (grid) grid.innerHTML = "";
        return;
    }

    renderCompanies(allCompanies);
}

function renderCompanies(companies) {

    const grid = document.getElementById("companyGrid");
    if (!grid) return;

    grid.innerHTML = "";

    companies.forEach(company => {

        const address = formatAddress(company);
        const hasW9 = Boolean(company.W9FilePath);

        const card = document.createElement("div");
        card.className = "workbook-card company-card";
        card.dataset.companyId = company.id;

        card.innerHTML = `
            <div class="company-card-body">

                <button
                    type="button"
                    class="company-edit-btn"
                    data-id="${company.id}"
                    aria-label="Edit company">
                    <span class="company-edit-icon"></span>
                </button>

                <h3 class="company-card-name">${escapeHtmlCompanies(company.Name || "Unnamed company")}</h3>

                <div class="company-card-address">
                    ${address.street ? `<p>${escapeHtmlCompanies(address.street)}</p>` : ""}
                    ${address.line2 ? `<p>${escapeHtmlCompanies(address.line2)}</p>` : ""}
                    ${(!address.street && !address.line2) ? `<p class="company-card-muted">No address on file</p>` : ""}
                </div>

                <div class="company-card-row">
                    <span class="company-card-label">SSN / FID</span>
                    <span class="company-card-value">${escapeHtmlCompanies(maskSsnFid(company["SSN/FID"]))}</span>
                </div>

                <div class="company-card-row">
                    <span class="company-card-label">W9</span>
                    <span class="chip ${hasW9 ? "" : "chip--muted"}">${hasW9 ? "On file" : "Missing"}</span>
                </div>

                <div class="workbook-actions">
                    <button type="button" class="workbook-btn workbook-btn--preview company-view-w9-btn" data-id="${company.id}" ${hasW9 ? "" : "disabled"}>
                        View W9
                    </button>
                </div>

            </div>
        `;

        grid.appendChild(card);
    });

    // Edit buttons
    grid.querySelectorAll(".company-edit-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            const company = allCompanies.find(c => String(c.id) === String(id));
            if (company) openCompanyModal(company);
        });
    });

    // View W9 buttons
    grid.querySelectorAll(".company-view-w9-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            const company = allCompanies.find(c => String(c.id) === String(id));
            if (company && company.W9FilePath) viewW9(company.W9FilePath);
        });
    });
}

/* ===========================
   VIEW W9 (signed URL, bucket is private)
=========================== */

async function viewW9(filePath) {

    if (!window.supabaseClient) return;

    const { data, error } = await window.supabaseClient
        .storage
        .from(W9_BUCKET)
        .createSignedUrl(filePath, 60 * 5); // 5 minute link

    if (error || !data?.signedUrl) {
        console.error("Failed to create signed URL for W9:", error);
        showCompanyMessage("Couldn't open that W9 file. Please try again.", "error");
        return;
    }

    window.open(data.signedUrl, "_blank", "noopener");
}

/* ===========================
   ADD / EDIT MODAL
=========================== */

function openCompanyModal(company) {

    const overlay = document.getElementById("companyModalOverlay");
    const title = document.getElementById("companyModalTitle");
    const subtitle = document.getElementById("companyModalSubtitle");
    const deleteBtn = document.getElementById("deleteCompanyBtn");
    const existingW9Note = document.getElementById("companyExistingW9Note");

    document.getElementById("companyIdInput").value = company?.id ?? "";
    document.getElementById("companyExistingW9PathInput").value = company?.W9FilePath ?? "";
    document.getElementById("companyNameInput").value = company?.Name ?? "";
    document.getElementById("companyStreetInput").value = company?.Street ?? "";
    document.getElementById("companyCityInput").value = company?.City ?? "";
    document.getElementById("companyStateInput").value = company?.State ?? "";
    document.getElementById("companyZipInput").value = company?.Zip ?? "";
    document.getElementById("companySsnFidInput").value = company?.["SSN/FID"] ?? "";
    document.getElementById("companyW9Input").value = "";

    setFormMessage("", "");

    if (company?.id) {
        title.textContent = "Edit Company";
        subtitle.textContent = "Update the company's details, or delete it below.";
        deleteBtn.style.display = "block";

        if (company.W9FilePath) {
            existingW9Note.style.display = "block";
            existingW9Note.textContent = "A W9 is already on file. Uploading a new one will replace it.";
        } else {
            existingW9Note.style.display = "none";
        }
    } else {
        title.textContent = "Add Company";
        subtitle.textContent = "Enter the company's details below.";
        deleteBtn.style.display = "none";
        existingW9Note.style.display = "none";
    }

    overlay.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeCompanyModal() {
    const overlay = document.getElementById("companyModalOverlay");
    overlay.classList.add("hidden");
    document.body.classList.remove("popup-active");
}

async function handleCompanyFormSubmit(event) {

    event.preventDefault();

    const submitBtn = document.getElementById("submitCompanyBtn");
    const id = document.getElementById("companyIdInput").value;
    const existingW9Path = document.getElementById("companyExistingW9PathInput").value;

    const payload = {
        Name: document.getElementById("companyNameInput").value.trim(),
        Street: document.getElementById("companyStreetInput").value.trim() || null,
        City: document.getElementById("companyCityInput").value.trim() || null,
        State: document.getElementById("companyStateInput").value.trim().toUpperCase() || null,
        Zip: document.getElementById("companyZipInput").value.trim()
            ? Number(document.getElementById("companyZipInput").value.trim())
            : null,
        "SSN/FID": document.getElementById("companySsnFidInput").value.trim() || null
    };

    if (!payload.Name) {
        setFormMessage("Company name is required.", "error");
        return;
    }

    submitBtn.disabled = true;
    setFormMessage("Saving…", "");

    try {

        const w9File = document.getElementById("companyW9Input").files[0];

        if (w9File) {
            const uploadedPath = await uploadW9(w9File, existingW9Path);
            payload.W9FilePath = uploadedPath;
        }

        let saveError;

        if (id) {
            const { error } = await window.supabaseClient
                .from(COMPANIES_TABLE)
                .update(payload)
                .eq("id", id);
            saveError = error;
        } else {
            const { error } = await window.supabaseClient
                .from(COMPANIES_TABLE)
                .insert(payload);
            saveError = error;
        }

        if (saveError) throw saveError;

        closeCompanyModal();
        showCompanyMessage(id ? "Company updated." : "Company added.", "success");
        await loadCompanies();

    } catch (error) {
        console.error("Failed to save company:", error);
        setFormMessage("Something went wrong saving this company. Please try again.", "error");
    } finally {
        submitBtn.disabled = false;
    }
}

async function uploadW9(file, existingPath) {

    const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const path = `${Date.now()}-${safeName}`;

    const { error: uploadError } = await window.supabaseClient
        .storage
        .from(W9_BUCKET)
        .upload(path, file, { upsert: false });

    if (uploadError) throw uploadError;

    // Best-effort cleanup of the old file — don't block the save on this.
    if (existingPath) {
        window.supabaseClient
            .storage
            .from(W9_BUCKET)
            .remove([existingPath])
            .catch(err => console.warn("Couldn't remove old W9 file:", err));
    }

    return path;
}

/* ===========================
   DELETE
=========================== */

let pendingDeleteId = null;
let pendingDeleteW9Path = null;

function openDeleteConfirm() {
    const id = document.getElementById("companyIdInput").value;
    const w9Path = document.getElementById("companyExistingW9PathInput").value;

    if (!id) return;

    pendingDeleteId = id;
    pendingDeleteW9Path = w9Path || null;

    document.getElementById("deleteConfirmMessage").textContent = "";
    document.getElementById("deleteConfirmOverlay").classList.remove("hidden");
}

function closeDeleteConfirm() {
    document.getElementById("deleteConfirmOverlay").classList.add("hidden");
    pendingDeleteId = null;
    pendingDeleteW9Path = null;
}

async function confirmDeleteCompany() {

    if (!pendingDeleteId) return;

    const confirmBtn = document.getElementById("confirmDeleteBtn");
    confirmBtn.disabled = true;

    try {

        const { error } = await window.supabaseClient
            .from(COMPANIES_TABLE)
            .delete()
            .eq("id", pendingDeleteId);

        if (error) throw error;

        if (pendingDeleteW9Path) {
            window.supabaseClient
                .storage
                .from(W9_BUCKET)
                .remove([pendingDeleteW9Path])
                .catch(err => console.warn("Couldn't remove W9 file:", err));
        }

        closeDeleteConfirm();
        closeCompanyModal();
        showCompanyMessage("Company deleted.", "success");
        await loadCompanies();

    } catch (error) {
        console.error("Failed to delete company:", error);
        document.getElementById("deleteConfirmMessage").textContent =
            "Something went wrong deleting this company. Please try again.";
        document.getElementById("deleteConfirmMessage").className = "auth-message error";
    } finally {
        confirmBtn.disabled = false;
    }
}

/* ===========================
   INIT
=========================== */

window.initCompaniesPage = function () {

    loadCompanies();

    const addBtn = document.getElementById("addCompanyBtn");
    if (addBtn) addBtn.addEventListener("click", () => openCompanyModal(null));

    const cancelBtn = document.getElementById("cancelCompanyBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", closeCompanyModal);

    const overlay = document.getElementById("companyModalOverlay");
    if (overlay) {
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) closeCompanyModal();
        });
    }

    const form = document.getElementById("companyForm");
    if (form) form.addEventListener("submit", handleCompanyFormSubmit);

    const deleteBtn = document.getElementById("deleteCompanyBtn");
    if (deleteBtn) deleteBtn.addEventListener("click", openDeleteConfirm);

    const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
    if (cancelDeleteBtn) cancelDeleteBtn.addEventListener("click", closeDeleteConfirm);

    const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener("click", confirmDeleteCompany);

    const deleteOverlay = document.getElementById("deleteConfirmOverlay");
    if (deleteOverlay) {
        deleteOverlay.addEventListener("click", (event) => {
            if (event.target === deleteOverlay) closeDeleteConfirm();
        });
    }

    hideCompanyMessage();
};