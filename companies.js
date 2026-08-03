/* ===========================================================
   COMPANIES PAGE
   Reads/writes public."Companies" in Supabase.
   Custom auth model: no auth.uid(), RLS is open to anon,
   access control is app-level (see supabase-companies-setup.sql).
=========================================================== */

const COMPANIES_TABLE = "Companies";
const W9_BUCKET = "company-w9s";

/* ===========================
   VENDOR TAGS (Supabase)
   Tables: vendor_tag_categories, vendor_tags, company_tags
   (see supabase-vendor-tags-setup.sql). Categories are data-driven rather
   than hardcoded, so a new category can be added from the Manage Tags
   popup without touching any code.
=========================== */

const TAG_CATEGORIES_TABLE = "vendor_tag_categories";
const TAGS_TABLE = "vendor_tags";
const COMPANY_TAGS_TABLE = "company_tags";

let allTagCategories = []; // [{ id, name, sort_order }]
let allTags = [];          // [{ id, category_id, name }]
let allCompanyTags = [];   // [{ id, company_id, tag_id }]

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
   VENDOR TAGS — load + lookup helpers
=========================== */

async function loadVendorTagData() {

    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        return;
    }

    const [categoriesRes, tagsRes, companyTagsRes] = await Promise.all([
        window.supabaseClient.from(TAG_CATEGORIES_TABLE).select("*").order("sort_order", { ascending: true }),
        window.supabaseClient.from(TAGS_TABLE).select("*").order("name", { ascending: true }),
        window.supabaseClient.from(COMPANY_TAGS_TABLE).select("*")
    ]);

    if (categoriesRes.error) console.error("Failed to load tag categories:", categoriesRes.error);
    if (tagsRes.error) console.error("Failed to load tags:", tagsRes.error);
    if (companyTagsRes.error) console.error("Failed to load company tags:", companyTagsRes.error);

    allTagCategories = categoriesRes.data || [];
    allTags = tagsRes.data || [];
    allCompanyTags = companyTagsRes.data || [];
}

// All tags currently assigned to a vendor, each annotated with its category.
function tagsForCompany(companyId) {
    const tagIds = new Set(
        allCompanyTags
            .filter(ct => String(ct.company_id) === String(companyId))
            .map(ct => String(ct.tag_id))
    );
    return allTags.filter(tag => tagIds.has(String(tag.id)));
}

// Groups a flat list of tags by category, in category sort order. Returns
// [{ category, tags }] — every category is included even if empty, so
// callers (profile popup, tag picker) can show "None assigned" / render
// checkboxes for categories with nothing selected yet.
function groupTagsByCategory(tagList) {
    const byCategory = new Map();
    allTagCategories.forEach(cat => byCategory.set(String(cat.id), { category: cat, tags: [] }));
    tagList.forEach(tag => {
        const group = byCategory.get(String(tag.category_id));
        if (group) group.tags.push(tag);
    });
    return Array.from(byCategory.values());
}

/* ===========================
   VENDOR APPROVAL STATUS
   Fully derived from other fields — no DB column, no manual override.
   A vendor is "Approved" only once it has: Name, Street, City, State, Zip,
   SSN/FID, a W9 on file, AND at least one tag from every existing tag
   category (currently Asset Specialty + Trade — this stays correct even if
   a category is added or removed later, since it loops allTagCategories).
=========================== */

function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === "";
}

// Returns the list of human-readable things this vendor is missing.
// Empty array = approved.
function missingVendorRequirements(company) {
    if (!company) return ["Vendor name", "Street", "City", "State", "Zip", "SSN / FID", "W9"];

    const missing = [];
    if (isBlank(company.Name)) missing.push("Vendor name");
    if (isBlank(company.Street)) missing.push("Street");
    if (isBlank(company.City)) missing.push("City");
    if (isBlank(company.State)) missing.push("State");
    if (isBlank(company.Zip)) missing.push("Zip");
    if (isBlank(company["SSN/FID"])) missing.push("SSN / FID");
    if (!company.W9FilePath) missing.push("W9");

    if (allTagCategories.length === 0) {
        missing.push("Tags");
    } else {
        const companyTags = tagsForCompany(company.id);
        allTagCategories.forEach(cat => {
            const hasOneFromCategory = companyTags.some(tag => String(tag.category_id) === String(cat.id));
            if (!hasOneFromCategory) missing.push(`${cat.name} tag`);
        });
    }

    return missing;
}

function isVendorApproved(company) {
    return missingVendorRequirements(company).length === 0;
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
        const companyTags = tagsForCompany(company.id);
        const approved = isVendorApproved(company);

        const card = document.createElement("div");
        card.className = "workbook-card company-card";
        card.dataset.companyId = company.id;

        card.innerHTML = `
            <div class="company-card-body">

                <button
                    type="button"
                    class="company-edit-btn"
                    data-id="${company.id}"
                    aria-label="Edit Vendor">
                    <span class="company-edit-icon"></span>
                </button>

                <h3 class="company-card-name">${escapeHtmlCompanies(company.Name || "Unnamed company")}</h3>

                <div class="company-card-address">
                    ${address.street ? `<p>${escapeHtmlCompanies(address.street)}</p>` : ""}
                    ${address.line2 ? `<p>${escapeHtmlCompanies(address.line2)}</p>` : ""}
                    ${(!address.street && !address.line2) ? `<p class="company-card-muted">No address on file</p>` : ""}
                </div>

                ${companyTags.length ? `
                <div class="company-card-tags">
                    ${companyTags.slice(0, 2).map(tag => `<span class="chip chip--tag">${escapeHtmlCompanies(tag.name)}</span>`).join("")}
                    ${companyTags.length > 2 ? `<span class="chip chip--muted">+${companyTags.length - 2} more</span>` : ""}
                </div>` : ""}

                <div class="company-card-row">
                    <span class="company-card-label">Status</span>
                    <span class="chip ${approved ? "chip--success" : "chip--danger"}">${approved ? "Approved" : "Not Approved"}</span>
                </div>

                <div class="company-card-row">
                    <span class="company-card-label">SSN / FID</span>
                    <span class="company-card-value">${escapeHtmlCompanies(maskSsnFid(company["SSN/FID"]))}</span>
                </div>

                <div class="company-card-row">
                    <span class="company-card-label">W9</span>
                    <span class="chip ${hasW9 ? "" : "chip--muted"}">${hasW9 ? "On file" : "Missing"}</span>
                </div>

                <div class="workbook-actions workbook-pill-group">
    <button
        type="button"
        class="workbook-btn workbook-btn--preview company-view-w9-btn"
        data-id="${company.id}"
        ${hasW9 ? "" : "disabled"}
    >
        View W9
    </button>

    <button
        type="button"
        class="workbook-btn workbook-btn--download company-download-w9-btn"
        data-id="${company.id}"
        ${hasW9 ? "" : "disabled"}
    >
        Download W9
    </button>
</div>

                <a href="#" class="company-view-contacts-link" data-id="${company.id}" data-name="${escapeHtmlCompanies(company.Name || "")}">View Contact Info</a>

            </div>
        `;

        grid.appendChild(card);
    });

    // Card click (anywhere except an interactive element) opens the
    // read-only vendor profile popup.
    grid.querySelectorAll(".company-card").forEach(card => {
        card.addEventListener("click", (event) => {
            if (event.target.closest(".company-edit-btn, .company-view-w9-btn, .company-download-w9-btn, .company-view-contacts-link")) return;
            const id = card.dataset.companyId;
            const company = allCompanies.find(c => String(c.id) === String(id));
            if (company) openVendorProfileModal(company);
        });
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

    // View Contact Info links
    grid.querySelectorAll(".company-view-contacts-link").forEach(link => {
        link.addEventListener("click", (event) => {
            event.preventDefault();
            const id = link.dataset.id;
            const company = allCompanies.find(c => String(c.id) === String(id));
            if (company) openContactsModal(company);
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
   VENDOR PROFILE (read-only popup, opened by clicking a card)
=========================== */

let currentProfileCompany = null;

function openVendorProfileModal(company) {

    currentProfileCompany = company;

    const overlay = document.getElementById("vendorProfileModalOverlay");
    const address = formatAddress(company);
    const hasW9 = Boolean(company.W9FilePath);

    document.getElementById("vendorProfileName").textContent = company.Name || "Unnamed company";

    const addressEl = document.getElementById("vendorProfileAddress");
    addressEl.innerHTML = (address.street || address.line2)
        ? `${address.street ? `<p>${escapeHtmlCompanies(address.street)}</p>` : ""}${address.line2 ? `<p>${escapeHtmlCompanies(address.line2)}</p>` : ""}`
        : `<p class="company-card-muted">No address on file</p>`;

    const missing = missingVendorRequirements(company);
    const approved = missing.length === 0;
    const statusEl = document.getElementById("vendorProfileApprovalStatus");
    statusEl.innerHTML = `
        <span class="chip ${approved ? "chip--success" : "chip--danger"}">${approved ? "Approved" : "Not Approved"}</span>
        ${!approved ? `<p class="vendor-profile-missing">Missing: ${escapeHtmlCompanies(missing.join(", "))}</p>` : ""}
    `;

    document.getElementById("vendorProfileSsnFid").textContent = maskSsnFid(company["SSN/FID"]);

    const w9StatusEl = document.getElementById("vendorProfileW9Status");
    w9StatusEl.innerHTML = hasW9
        ? `<span class="chip">On file</span> <button type="button" class="workbook-btn workbook-btn--preview" id="vendorProfileViewW9Btn">View W9</button>`
        : `<span class="chip chip--muted">Missing</span>`;

    const viewW9Btn = document.getElementById("vendorProfileViewW9Btn");
    if (viewW9Btn) {
        viewW9Btn.addEventListener("click", () => viewW9(company.W9FilePath));
    }

    const groups = groupTagsByCategory(tagsForCompany(company.id));
    const tagGroupsEl = document.getElementById("vendorProfileTagGroups");
    tagGroupsEl.innerHTML = groups.map(({ category, tags }) => `
        <div class="vendor-profile-section">
            <span class="company-card-label">${escapeHtmlCompanies(category.name)}</span>
            <div class="vendor-profile-tag-list">
                ${tags.length
                    ? tags.map(tag => `<span class="chip chip--tag">${escapeHtmlCompanies(tag.name)}</span>`).join("")
                    : `<span class="company-card-muted">None assigned</span>`
                }
            </div>
        </div>
    `).join("");

    overlay.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeVendorProfileModal() {
    document.getElementById("vendorProfileModalOverlay").classList.add("hidden");
    document.body.classList.remove("popup-active");
    currentProfileCompany = null;
}

/* ===========================
   TAG PICKER (inside Add/Edit Vendor form)
=========================== */

// Renders one checkbox group per category into #companyTagsFieldWrap, with
// a search box per group (most useful for the long Trade list). Groups with
// no tags yet (e.g. a brand new category) still render, just with an empty
// "no tags in this category yet" note.
function renderTagPicker(selectedTagIds) {
    const wrap = document.getElementById("companyTagsFieldWrap");
    if (!wrap) return;

    const selected = selectedTagIds || new Set();
    const groups = groupTagsByCategory(allTags);

    wrap.innerHTML = groups.map(({ category, tags }) => `
        <div class="tag-picker-group" data-category-id="${category.id}">
            <div class="tag-picker-group-title">${escapeHtmlCompanies(category.name)}</div>
            ${tags.length > 6 ? `<input type="text" class="tag-picker-search" placeholder="Search ${escapeHtmlCompanies(category.name)}…">` : ""}
            <div class="tag-picker-options">
                ${tags.length ? tags.map(tag => `
                    <label class="tag-picker-option">
                        <input type="checkbox" value="${tag.id}" ${selected.has(String(tag.id)) ? "checked" : ""}>
                        <span>${escapeHtmlCompanies(tag.name)}</span>
                    </label>
                `).join("") : `<p class="company-card-muted">No tags in this category yet — add some from Manage Tags.</p>`}
            </div>
        </div>
    `).join("");

    // Per-group search filter
    wrap.querySelectorAll(".tag-picker-group").forEach(group => {
        const search = group.querySelector(".tag-picker-search");
        if (!search) return;
        search.addEventListener("input", () => {
            const query = search.value.trim().toLowerCase();
            group.querySelectorAll(".tag-picker-option").forEach(option => {
                const text = option.textContent.trim().toLowerCase();
                option.style.display = (!query || text.includes(query)) ? "" : "none";
            });
        });
    });
}

function collectSelectedTagIds() {
    const wrap = document.getElementById("companyTagsFieldWrap");
    if (!wrap) return [];
    return Array.from(wrap.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

async function saveCompanyTags(companyId, selectedTagIds) {
    const existing = allCompanyTags
        .filter(ct => String(ct.company_id) === String(companyId))
        .map(ct => String(ct.tag_id));

    const selectedSet = new Set(selectedTagIds.map(String));
    const existingSet = new Set(existing);

    const toAdd = selectedTagIds.filter(id => !existingSet.has(String(id)));
    const toRemove = existing.filter(id => !selectedSet.has(id));

    if (toAdd.length) {
        const { error } = await window.supabaseClient
            .from(COMPANY_TAGS_TABLE)
            .insert(toAdd.map(tagId => ({ company_id: companyId, tag_id: tagId })));
        if (error) console.error("Failed to add vendor tags:", error);
    }

    if (toRemove.length) {
        const { error } = await window.supabaseClient
            .from(COMPANY_TAGS_TABLE)
            .delete()
            .eq("company_id", companyId)
            .in("tag_id", toRemove);
        if (error) console.error("Failed to remove vendor tags:", error);
    }

    await loadVendorTagData();
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

    const selectedTagIds = new Set(
        company?.id ? tagsForCompany(company.id).map(tag => String(tag.id)) : []
    );
    renderTagPicker(selectedTagIds);

    setFormMessage("", "");

    if (company?.id) {
        title.textContent = "Edit Vendor";
        subtitle.textContent = "Update the vendor's details, or delete it below.";
        deleteBtn.style.display = "block";

        if (company.W9FilePath) {
            existingW9Note.style.display = "block";
            existingW9Note.textContent = "A W9 is already on file. Uploading a new one will replace it.";
        } else {
            existingW9Note.style.display = "none";
        }
    } else {
        title.textContent = "Add Vendor";
        subtitle.textContent = "Enter the Vendor's details below.";
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
        let savedCompanyId = id;

        if (id) {
            const { error } = await window.supabaseClient
                .from(COMPANIES_TABLE)
                .update(payload)
                .eq("id", id);
            saveError = error;
        } else {
            const { data, error } = await window.supabaseClient
                .from(COMPANIES_TABLE)
                .insert(payload)
                .select()
                .single();
            saveError = error;
            savedCompanyId = data?.id;
        }

        if (saveError) throw saveError;

        if (savedCompanyId) {
            await saveCompanyTags(savedCompanyId, collectSelectedTagIds());
        }

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
   DELETE (shared by companies + contacts)
=========================== */

let pendingDeleteType = null; // "company" | "contact"
let pendingDeleteId = null;
let pendingDeleteW9Path = null;

function openDeleteConfirm() {
    const id = document.getElementById("companyIdInput").value;
    const w9Path = document.getElementById("companyExistingW9PathInput").value;

    if (!id) return;

    pendingDeleteType = "company";
    pendingDeleteId = id;
    pendingDeleteW9Path = w9Path || null;

    document.getElementById("deleteConfirmText").textContent =
        "This will permanently remove the vendor record and its W9 file. This can't be undone.";
    document.getElementById("deleteConfirmMessage").textContent = "";
    document.getElementById("deleteConfirmOverlay").classList.remove("hidden");
}

function openContactDeleteConfirm() {
    const id = document.getElementById("contactIdInput").value;

    if (!id) return;

    pendingDeleteType = "contact";
    pendingDeleteId = id;
    pendingDeleteW9Path = null;

    document.getElementById("deleteConfirmText").textContent =
        "This will permanently remove this contact. This can't be undone.";
    document.getElementById("deleteConfirmMessage").textContent = "";
    document.getElementById("deleteConfirmOverlay").classList.remove("hidden");
}

function closeDeleteConfirm() {
    document.getElementById("deleteConfirmOverlay").classList.add("hidden");
    pendingDeleteType = null;
    pendingDeleteId = null;
    pendingDeleteW9Path = null;
}

async function confirmDelete() {

    if (!pendingDeleteId || !pendingDeleteType) return;

    const confirmBtn = document.getElementById("confirmDeleteBtn");
    confirmBtn.disabled = true;

    try {

        if (pendingDeleteType === "company") {

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
            showCompanyMessage("Vendor deleted.", "success");
            await loadCompanies();

        } else if (pendingDeleteType === "contact") {

            const companyId = document.getElementById("contactCompanyIdInput").value;

            const { error } = await window.supabaseClient
                .from(CONTACTS_TABLE)
                .delete()
                .eq("id", pendingDeleteId);

            if (error) throw error;

            closeDeleteConfirm();
            closeContactFormModal();
            await refreshContactsList(companyId);

        }

    } catch (error) {
        console.error("Failed to delete:", error);
        document.getElementById("deleteConfirmMessage").textContent =
            "Something went wrong deleting this. Please try again.";
        document.getElementById("deleteConfirmMessage").className = "auth-message error";
    } finally {
        confirmBtn.disabled = false;
    }
}

/* ===========================
   CONTACTS
=========================== */

const CONTACTS_TABLE = "Contacts";

function setContactFormMessage(text, type) {
    const el = document.getElementById("contactFormMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `auth-message ${type || ""}`.trim();
}

async function openContactsModal(company) {

    const overlay = document.getElementById("contactsModalOverlay");
    const titleEl = document.getElementById("contactsModalTitle");

    document.getElementById("contactsModalCompanyId").value = company.id;
    titleEl.textContent = `Contacts — ${company.Name || "Company"}`;
    titleEl.dataset.companyName = company.Name || "";

    overlay.classList.remove("hidden");
    document.body.classList.add("popup-active");

    await refreshContactsList(company.id);
}

function closeContactsModal() {
    document.getElementById("contactsModalOverlay").classList.add("hidden");
    if (document.getElementById("contactModalOverlay").classList.contains("hidden")) {
        document.body.classList.remove("popup-active");
    }
}

async function refreshContactsList(companyId) {

    const body = document.getElementById("contactsListBody");
    body.innerHTML = `<p class="workbook-preview-loading">Loading contacts…</p>`;

    const { data, error } = await window.supabaseClient
        .from(CONTACTS_TABLE)
        .select("*")
        .eq("company_id", companyId)
        .order("Name", { ascending: true });

    if (error) {
        console.error("Failed to load contacts:", error);
        body.innerHTML = `<p class="workbook-preview-empty">Couldn't load contacts. Please try again.</p>`;
        return;
    }

    renderContactList(data || [], companyId);
}

function renderContactList(contacts, companyId) {

    const body = document.getElementById("contactsListBody");

    if (!contacts.length) {
        body.innerHTML = `<p class="workbook-preview-empty">No contacts on file for this company yet.</p>`;
        return;
    }

    const companyName = document.getElementById("contactsModalTitle").dataset.companyName || "";

    body.innerHTML = `
        <div class="contact-list">
            ${contacts.map(contact => `
                <div class="contact-item">

                    <button
                        type="button"
                        class="company-edit-btn contact-edit-btn"
                        data-id="${contact.id}"
                        aria-label="Edit contact">
                        <span class="company-edit-icon"></span>
                    </button>

                    <h4 class="contact-item-name">${escapeHtmlCompanies(contact.Name || "Unnamed contact")}</h4>
                    ${contact.Title ? `<p class="contact-item-title">${escapeHtmlCompanies(contact.Title)}</p>` : ""}

                    <div class="contact-item-details">
                        ${contact.WorkPhone ? `<p><span class="company-card-label">Work</span> ${escapeHtmlCompanies(contact.WorkPhone)}</p>` : ""}
                        ${contact.MobilePhone ? `<p><span class="company-card-label">Mobile</span> ${escapeHtmlCompanies(contact.MobilePhone)}</p>` : ""}
                        ${contact.Email ? `<p><span class="company-card-label">Email</span> ${escapeHtmlCompanies(contact.Email)}</p>` : ""}
                        ${contact.Role ? `<p><span class="company-card-label">Role</span> ${escapeHtmlCompanies(contact.Role)}</p>` : ""}
                    </div>

                </div>
            `).join("")}
        </div>
    `;

    body.querySelectorAll(".contact-edit-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const contact = contacts.find(c => String(c.id) === String(btn.dataset.id));
            if (contact) openContactFormModal(contact, companyId, companyName);
        });
    });
}

function openContactFormModal(contact, companyId, companyName) {

    const overlay = document.getElementById("contactModalOverlay");
    const title = document.getElementById("contactModalTitle");
    const deleteBtn = document.getElementById("deleteContactBtn");

    document.getElementById("contactIdInput").value = contact?.id ?? "";
    document.getElementById("contactCompanyIdInput").value = companyId;
    document.getElementById("contactNameInput").value = contact?.Name ?? "";
    document.getElementById("contactTitleInput").value = contact?.Title ?? "";
    document.getElementById("contactWorkPhoneInput").value = contact?.WorkPhone ?? "";
    document.getElementById("contactMobilePhoneInput").value = contact?.MobilePhone ?? "";
    document.getElementById("contactEmailInput").value = contact?.Email ?? "";
    document.getElementById("contactRoleInput").value = contact?.Role ?? "";

    title.textContent = contact?.id
        ? `Edit Contact — ${companyName || "Company"}`
        : `Add Contact — ${companyName || "Company"}`;

    deleteBtn.style.display = contact?.id ? "block" : "none";

    setContactFormMessage("", "");

    overlay.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeContactFormModal() {
    document.getElementById("contactModalOverlay").classList.add("hidden");
    if (document.getElementById("contactsModalOverlay").classList.contains("hidden")) {
        document.body.classList.remove("popup-active");
    }
}

async function handleContactFormSubmit(event) {

    event.preventDefault();

    const submitBtn = document.getElementById("submitContactBtn");
    const id = document.getElementById("contactIdInput").value;
    const companyId = document.getElementById("contactCompanyIdInput").value;

    const payload = {
        company_id: companyId,
        Name: document.getElementById("contactNameInput").value.trim(),
        Title: document.getElementById("contactTitleInput").value.trim() || null,
        WorkPhone: document.getElementById("contactWorkPhoneInput").value.trim() || null,
        MobilePhone: document.getElementById("contactMobilePhoneInput").value.trim() || null,
        Email: document.getElementById("contactEmailInput").value.trim() || null,
        Role: document.getElementById("contactRoleInput").value.trim() || null
    };

    if (!payload.Name) {
        setContactFormMessage("Contact name is required.", "error");
        return;
    }

    submitBtn.disabled = true;
    setContactFormMessage("Saving…", "");

    try {

        let saveError;

        if (id) {
            const { error } = await window.supabaseClient
                .from(CONTACTS_TABLE)
                .update(payload)
                .eq("id", id);
            saveError = error;
        } else {
            const { error } = await window.supabaseClient
                .from(CONTACTS_TABLE)
                .insert(payload);
            saveError = error;
        }

        if (saveError) throw saveError;

        closeContactFormModal();
        await refreshContactsList(companyId);

    } catch (error) {
        console.error("Failed to save contact:", error);
        setContactFormMessage("Something went wrong saving this contact. Please try again.", "error");
    } finally {
        submitBtn.disabled = false;
    }
}

/* ===========================
   MANAGE TAGS (add/rename/delete categories + tags)
=========================== */

function setManageTagsMessage(text, type) {
    const el = document.getElementById("manageTagsMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `auth-message ${type || ""}`.trim();
}

function openManageTagsModal() {
    renderManageTagsCategories();
    setManageTagsMessage("", "");
    document.getElementById("manageTagsModalOverlay").classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeManageTagsModal() {
    document.getElementById("manageTagsModalOverlay").classList.add("hidden");
    document.body.classList.remove("popup-active");
}

function renderManageTagsCategories() {
    const wrap = document.getElementById("manageTagsCategories");
    if (!wrap) return;

    const groups = groupTagsByCategory(allTags);

    wrap.innerHTML = groups.map(({ category, tags }) => `
        <div class="tag-admin-category" data-category-id="${category.id}">
            <div class="tag-admin-category-header">
                <h3>${escapeHtmlCompanies(category.name)}</h3>
                <div class="tag-admin-category-actions">
                    <button type="button" class="workbook-btn workbook-btn--preview tag-admin-rename-cat" data-id="${category.id}">Rename</button>
                    <button type="button" class="workbook-btn workbook-btn--danger tag-admin-delete-cat" data-id="${category.id}">Delete</button>
                </div>
            </div>
            <div class="tag-admin-tag-list">
                ${tags.length ? tags.map(tag => `
                    <div class="tag-admin-tag-row" data-tag-id="${tag.id}">
                        <span>${escapeHtmlCompanies(tag.name)}</span>
                        <div class="tag-admin-tag-actions">
                            <button type="button" class="tag-admin-rename-tag" data-id="${tag.id}">Rename</button>
                            <button type="button" class="tag-admin-delete-tag" data-id="${tag.id}">Delete</button>
                        </div>
                    </div>
                `).join("") : `<p class="company-card-muted">No tags yet.</p>`}
            </div>
            <div class="tag-admin-add-tag">
                <input type="text" class="tag-admin-new-tag-input" data-category-id="${category.id}" placeholder="New tag name">
                <button type="button" class="workbook-btn workbook-btn--preview tag-admin-add-tag-btn" data-category-id="${category.id}">+ Add Tag</button>
            </div>
        </div>
    `).join("");
}

// After any tag/category mutation: reload the underlying data, then
// re-render everything that shows tags (vendor cards, the manage-tags
// list, and the tag picker if the Add/Edit Vendor form happens to be open).
async function refreshAfterTagAdminChange() {
    await loadVendorTagData();
    renderCompanies(allCompanies);
    renderManageTagsCategories();

    const companyModalOverlay = document.getElementById("companyModalOverlay");
    if (companyModalOverlay && !companyModalOverlay.classList.contains("hidden")) {
        const id = document.getElementById("companyIdInput").value;
        const selectedTagIds = new Set(
            id ? tagsForCompany(id).map(tag => String(tag.id)) : []
        );
        renderTagPicker(selectedTagIds);
    }
}

async function addTagCategory() {
    const input = document.getElementById("newTagCategoryInput");
    const name = input.value.trim();
    if (!name) return;

    const nextSortOrder = allTagCategories.reduce((max, cat) => Math.max(max, cat.sort_order || 0), 0) + 1;

    const { error } = await window.supabaseClient
        .from(TAG_CATEGORIES_TABLE)
        .insert({ name, sort_order: nextSortOrder });

    if (error) {
        console.error("Failed to add tag category:", error);
        setManageTagsMessage("Couldn't add that category — it may already exist.", "error");
        return;
    }

    input.value = "";
    setManageTagsMessage("Category added.", "success");
    await refreshAfterTagAdminChange();
}

async function renameTagCategory(categoryId) {
    const category = allTagCategories.find(c => String(c.id) === String(categoryId));
    if (!category) return;

    const newName = prompt("Rename category:", category.name);
    if (!newName || !newName.trim() || newName.trim() === category.name) return;

    const { error } = await window.supabaseClient
        .from(TAG_CATEGORIES_TABLE)
        .update({ name: newName.trim() })
        .eq("id", categoryId);

    if (error) {
        console.error("Failed to rename category:", error);
        setManageTagsMessage("Couldn't rename that category.", "error");
        return;
    }

    await refreshAfterTagAdminChange();
}

async function deleteTagCategory(categoryId) {
    const category = allTagCategories.find(c => String(c.id) === String(categoryId));
    if (!category) return;

    if (!confirm(`Delete "${category.name}" and every tag in it? This removes those tags from all vendors that have them. This can't be undone.`)) return;

    const { error } = await window.supabaseClient
        .from(TAG_CATEGORIES_TABLE)
        .delete()
        .eq("id", categoryId);

    if (error) {
        console.error("Failed to delete category:", error);
        setManageTagsMessage("Couldn't delete that category.", "error");
        return;
    }

    await refreshAfterTagAdminChange();
}

async function addTagToCategory(categoryId, inputEl) {
    const name = inputEl.value.trim();
    if (!name) return;

    const { error } = await window.supabaseClient
        .from(TAGS_TABLE)
        .insert({ category_id: categoryId, name });

    if (error) {
        console.error("Failed to add tag:", error);
        setManageTagsMessage("Couldn't add that tag — it may already exist in this category.", "error");
        return;
    }

    setManageTagsMessage("Tag added.", "success");
    await refreshAfterTagAdminChange();
}

async function renameTag(tagId) {
    const tag = allTags.find(t => String(t.id) === String(tagId));
    if (!tag) return;

    const newName = prompt("Rename tag:", tag.name);
    if (!newName || !newName.trim() || newName.trim() === tag.name) return;

    const { error } = await window.supabaseClient
        .from(TAGS_TABLE)
        .update({ name: newName.trim() })
        .eq("id", tagId);

    if (error) {
        console.error("Failed to rename tag:", error);
        setManageTagsMessage("Couldn't rename that tag.", "error");
        return;
    }

    await refreshAfterTagAdminChange();
}

async function deleteTag(tagId) {
    const tag = allTags.find(t => String(t.id) === String(tagId));
    if (!tag) return;

    if (!confirm(`Delete "${tag.name}"? This removes it from every vendor that has it. This can't be undone.`)) return;

    const { error } = await window.supabaseClient
        .from(TAGS_TABLE)
        .delete()
        .eq("id", tagId);

    if (error) {
        console.error("Failed to delete tag:", error);
        setManageTagsMessage("Couldn't delete that tag.", "error");
        return;
    }

    await refreshAfterTagAdminChange();
}

/* ===========================
   REPORT: VENDORS BY APPROVAL STATUS
   Builds a real .pdf client-side (pdfmake, loaded via CDN in venders.html)
   from whatever is currently in allCompanies — no server round trip, so
   the report is always current as of the last page load.

   Layout matches the "Vender Approval Report.docx" template Coleby
   provided: letterhead header (logo + gray title + blue rule), gray
   metadata block (Report ID / Generated / Prepared by), an Executive
   Summary + Vender Criteria section, then bulleted Approve Venders /
   Unapproved Venders lists. Spelling ("Vender") is kept consistent with
   the template and the rest of this page.
=========================== */

const REPORT_META_COLOR = "#6B7280";
const REPORT_HEADER_TITLE_COLOR = "#595959";
const REPORT_RULE_COLOR = "#1E76BD";
const REPORT_LOGO_PATH = "logos/leewaed-logo.png"; // already used site-wide (favicon, login, index)

// Fetches the existing site logo as a data URL so it can be embedded in
// the PDF header. Returns null (not a throw) if it can't be loaded, so a
// missing logo never blocks the whole report from generating.
async function loadReportLogoDataUrl() {
    try {
        const res = await fetch(REPORT_LOGO_PATH);
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (err) {
        console.warn("Couldn't load report logo:", err);
        return null;
    }
}

function reportId(prefix = "VAR") {
    const stamp = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${prefix}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
}

function currentStaffName() {
    const profile = window.currentSupabaseProfile
        || JSON.parse(localStorage.getItem("staffProfile") || "null");
    return (profile && (profile.full_name || profile.username)) || "Staff Portal";
}

// Logs a row to the generated_reports table so a report can be looked up
// later by its Report ID (the one printed at the top of the PDF). This is
// metadata only — the PDF itself isn't stored, just who generated it, when,
// and a few counts/filters for context. Never blocks or fails report
// generation: if the insert errors (or Supabase isn't configured), this
// just logs to the console and the report still downloads normally.
const GENERATED_REPORTS_TABLE = "generated_reports";

async function logGeneratedReport(reportIdText, reportType, details = {}) {
    if (!window.supabaseClient) return;

    const profile = window.currentSupabaseProfile
        || JSON.parse(localStorage.getItem("staffProfile") || "null");

    try {
        const { error } = await window.supabaseClient.from(GENERATED_REPORTS_TABLE).insert({
            report_id: reportIdText,
            report_type: reportType,
            staff_id: profile && (profile.id ?? profile.uid) != null ? String(profile.id ?? profile.uid) : null,
            staff_name: currentStaffName(),
            details,
        });
        if (error) console.error("Failed to log generated report:", error);
    } catch (err) {
        console.error("Failed to log generated report:", err);
    }
}

// The gray "Report ID / Generated / Prepared by" block — appears at the
// top of every vendor report, matching the template. Takes the already-
// computed report ID string (rather than a prefix) so the same ID can also
// be logged via logGeneratedReport().
function reportMetadataBlock(generatedOn, staffName, reportIdText) {
    return {
        fontSize: 8.5,
        color: REPORT_META_COLOR,
        margin: [0, 0, 0, 10],
        text: [
            `Report ID: ${reportIdText}\n`,
            `Generated: ${generatedOn}\n`,
            `Prepared by: ${staffName}`,
        ],
    };
}

function reportHeading(text) {
    return { text, bold: true, fontSize: 14, margin: [0, 0, 0, 4] };
}

function reportSubheading(text) {
    return { text, bold: true, fontSize: 12, margin: [0, 6, 0, 2] };
}

function reportBodyItalic(text) {
    return { text, italics: true, margin: [20, 0, 0, 8] };
}

function reportVendorNameList(companies) {
    if (!companies.length) {
        return { text: "None.", italics: true };
    }
    return { ul: companies.map(c => c.Name || "Unnamed company"), italics: true, margin: [0, 0, 0, 4] };
}

// Letterhead header shared by every vendor report: logo top-left +
// "The Leeward Group, LLC" in gray bold, underlined by a 3pt blue rule —
// repeats on every page.
function buildReportLetterheadHeader(logoDataUrl) {
    const headerTitle = { text: "The Leeward Group, LLC", bold: true, fontSize: 20, color: REPORT_HEADER_TITLE_COLOR, alignment: "center" };
    return {
        margin: [50, 22, 50, 0],
        stack: [
            logoDataUrl
                ? { columns: [
                      { image: logoDataUrl, width: 55, height: 25 },
                      { ...headerTitle, margin: [0, 12, 55, 0] },
                  ] }
                : headerTitle,
            { canvas: [{ type: "line", x1: 0, y1: 8, x2: 495, y2: 8, lineWidth: 2.5, lineColor: REPORT_RULE_COLOR }] },
        ],
    };
}

// Footer shared by every vendor report: report title on the left, live
// "Page X of Y" on the right.
function buildReportFooter(titleText) {
    return (currentPage, pageCount) => ({
        margin: [50, 10, 50, 0],
        columns: [
            { text: titleText, fontSize: 9, color: "#333333" },
            { text: `Page ${currentPage} of ${pageCount}`, fontSize: 9, color: "#333333", alignment: "right" },
        ],
    });
}

// Builds the report as a PDF Blob (does NOT download it — that's a
// separate step so the caller can preview it first). Returns
// { ok, blob, fileName, approvedCount, notApprovedCount } on success,
// or { ok: false, error } on failure.
async function buildApprovalStatusReportPdf() {

    if (typeof pdfMake === "undefined") {
        console.error("pdfmake failed to load");
        return { ok: false, error: "Report library failed to load. Refresh and try again." };
    }

    const companies = [...allCompanies].sort((a, b) =>
        (a.Name || "").localeCompare(b.Name || "")
    );

    const approved = companies.filter(isVendorApproved);
    const notApproved = companies.filter(c => !isVendorApproved(c));

    const generatedOn = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    const staffName = currentStaffName();
    const logoDataUrl = await loadReportLogoDataUrl();
    const reportIdText = reportId("VAR");

    const docDefinition = {
        pageMargins: [50, 110, 50, 60],
        header: buildReportLetterheadHeader(logoDataUrl),
        footer: buildReportFooter("Vender Approval Report"),
        defaultStyle: { fontSize: 12 },

        content: [
            { text: "Vender Approval Report", bold: true, fontSize: 18, alignment: "center", margin: [0, 0, 0, 10] },
            reportMetadataBlock(generatedOn, staffName, reportIdText),

            reportHeading("1. Executive Summary:"),
            reportBodyItalic(
                `During this report, a total of ${companies.length} vendors were evaluated in our Leeward Group Data base. ` +
                `Of those reviewed, ${approved.length} vendors are approve venders, while ${notApproved.length} vendors were not approved based ` +
                `on the organization's evaluation criteria. See 1.a for vender criteria*.`
            ),
            {
                text: "This report supports ongoing efforts to maintain quality, manage risk, and ensure vendor performance aligns with organizational expectations.",
                italics: true,
                margin: [0, 0, 0, 8],
            },

            reportHeading("1.a. Vender Criteria:"),
            reportBodyItalic(
                "To be an Approve Vender in the Leeward Group database, then the following* must be met. Failure to do so will be flagged " +
                "automatically in our system, resulting in not being automatically selected in the bid process."
            ),
            {
                ul: ["Submitted W-9", "Valid SSN / FID", "Valid Address", "Proper internal tags", "Asset Specialty", "Trade code specialty"],
                italics: true,
                margin: [0, 0, 0, 10],
            },

            { text: "Approve Venders", bold: true, fontSize: 14, pageBreak: "before", margin: [0, 0, 0, 4] },
            reportVendorNameList(approved),

            { text: "Unapproved Venders", bold: true, fontSize: 14, margin: [0, 10, 0, 4] },
            reportVendorNameList(notApproved),
        ],
    };

    try {
        const blob = await pdfMake.createPdf(docDefinition).getBlob();
        const dateStamp = new Date().toISOString().slice(0, 10);

        await logGeneratedReport(reportIdText, "approval", {
            approvedCount: approved.length,
            notApprovedCount: notApproved.length,
        });

        return {
            ok: true,
            blob,
            fileName: `Vender-Approval-Report-${dateStamp}.pdf`,
            reportId: reportIdText,
            approvedCount: approved.length,
            notApprovedCount: notApproved.length,
        };
    } catch (err) {
        console.error("Failed to build approval status report:", err);
        return { ok: false, error: "Couldn't build the report file." };
    }
}

/* ===========================
   REPORT: VENDORS BY SPECIALTY
   Two flavors, both approved-vendors-only:
     - General: one flat, alphabetical list of every approved vendor
       (bold name) with all of its tags listed underneath — no category
       grouping.
     - Custom: driven by the wizard's selections, { [categoryId]: [tagId,...] }.
       Only categories with at least one selected tag get a section; within
       each, only the selected tags are shown, each with the approved
       vendors that carry it.
   Unapproved vendors are left out entirely from both, not shown with a
   status marker.
=========================== */

// Builds the "General" specialty report as a PDF Blob (does NOT download
// it — same preview-first pattern as the approval report). Returns
// { ok, blob, fileName, approvedCount } on success, or { ok: false, error }.
async function buildGeneralSpecialtyReportPdf() {

    if (typeof pdfMake === "undefined") {
        console.error("pdfmake failed to load");
        return { ok: false, error: "Report library failed to load. Refresh and try again." };
    }

    const approved = [...allCompanies]
        .filter(isVendorApproved)
        .sort((a, b) => (a.Name || "").localeCompare(b.Name || ""));

    const generatedOn = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    const staffName = currentStaffName();
    const logoDataUrl = await loadReportLogoDataUrl();
    const reportIdText = reportId("VSR");

    const bodyContent = approved.length
        ? approved.flatMap(company => {
            const tags = tagsForCompany(company.id).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            return [
                { text: company.Name || "Unnamed company", bold: true, fontSize: 13, margin: [0, 8, 0, 2] },
                tags.length
                    ? { ul: tags.map(t => t.name), italics: true, margin: [0, 0, 0, 0] }
                    : { text: "No tags assigned.", italics: true },
            ];
        })
        : [{ text: "No approved vendors to report.", italics: true }];

    const docDefinition = {
        pageMargins: [50, 110, 50, 60],
        header: buildReportLetterheadHeader(logoDataUrl),
        footer: buildReportFooter("Vender Specialty Report"),
        defaultStyle: { fontSize: 12 },

        content: [
            { text: "Vender Specialty Report", bold: true, fontSize: 18, alignment: "center", margin: [0, 0, 0, 10] },
            reportMetadataBlock(generatedOn, staffName, reportIdText),
            {
                text: "This report lists The Leeward Group's approved vendors along with all of their assigned specialty tags. " +
                    "Only approved vendors are included below.",
                italics: true,
                margin: [0, 0, 0, 10],
            },
            ...bodyContent,
        ],
    };

    try {
        const blob = await pdfMake.createPdf(docDefinition).getBlob();
        const dateStamp = new Date().toISOString().slice(0, 10);

        await logGeneratedReport(reportIdText, "specialty_general", {
            approvedCount: approved.length,
        });

        return {
            ok: true,
            blob,
            fileName: `Vender-Specialty-Report-general-${dateStamp}.pdf`,
            reportId: reportIdText,
            approvedCount: approved.length,
        };
    } catch (err) {
        console.error("Failed to build general specialty report:", err);
        return { ok: false, error: "Couldn't build the report file." };
    }
}

// Builds the "Custom" specialty report from the wizard's selections —
// { [categoryId]: [tagId, ...] }. A vendor must carry at least one selected
// tag from EVERY category that had a selection (so checking "Flex Space"
// in Asset Specialty and "1010 - Temporary Electric" in Trade only returns
// vendors that have both — categories with no selection just aren't used
// as a filter). If nothing was selected anywhere, the report still
// generates with a "No tags selected." body. If selections were made but
// no approved vendor matches all of them, NO PDF is built at all — this
// returns { ok: false, error, noMatches: true } so the wizard can show a
// message instead of opening a preview. Returns
// { ok, blob, fileName, approvedCount } on success, or { ok: false, error }.
async function buildCustomSpecialtyReportPdf(selections) {

    if (typeof pdfMake === "undefined") {
        console.error("pdfmake failed to load");
        return { ok: false, error: "Report library failed to load. Refresh and try again." };
    }

    const approved = [...allCompanies].filter(isVendorApproved);

    const sortedCategories = [...allTagCategories].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    const activeCategories = sortedCategories
        .map(category => {
            const selectedTagIds = new Set(((selections && selections[category.id]) || []).map(String));
            const tags = allTags
                .filter(t => String(t.category_id) === String(category.id) && selectedTagIds.has(String(t.id)))
                .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            return { category, tags };
        })
        .filter(group => group.tags.length > 0);

    let matchedVendors = [];

    if (activeCategories.length) {
        // A vendor qualifies if, for every category with a selection, it
        // carries at least one of that category's selected tags (OR within
        // a category, AND across categories).
        matchedVendors = approved
            .filter(company => {
                const companyTags = tagsForCompany(company.id);
                return activeCategories.every(group =>
                    group.tags.some(tag => companyTags.some(t => String(t.id) === String(tag.id)))
                );
            })
            .sort((a, b) => (a.Name || "").localeCompare(b.Name || ""));

        if (!matchedVendors.length) {
            return {
                ok: false,
                noMatches: true,
                error: "No approved vendor matches all of the selected tags.",
            };
        }
    }

    const generatedOn = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    const staffName = currentStaffName();
    const logoDataUrl = await loadReportLogoDataUrl();
    const reportIdText = reportId("VSR");

    const bodyContent = [];

    if (!activeCategories.length) {
        bodyContent.push({ text: "No tags selected.", italics: true });
    } else {
        const filterDescription = activeCategories
            .map(group => `${group.category.name}: ${group.tags.map(t => t.name).join(" or ")}`);

        bodyContent.push({
            text: "Matching all of the following:",
            bold: true,
            fontSize: 12,
            margin: [0, 0, 0, 2],
        });
        bodyContent.push({ ul: filterDescription, margin: [0, 0, 0, 10] });
        bodyContent.push(reportSubheading("Matching Venders"));
        bodyContent.push(reportVendorNameList(matchedVendors));
    }

    const docDefinition = {
        pageMargins: [50, 110, 50, 60],
        header: buildReportLetterheadHeader(logoDataUrl),
        footer: buildReportFooter("Vender Specialty Report"),
        defaultStyle: { fontSize: 12 },

        content: [
            { text: "Vender Specialty Report — Custom", bold: true, fontSize: 18, alignment: "center", margin: [0, 0, 0, 10] },
            reportMetadataBlock(generatedOn, staffName, reportIdText),
            {
                text: "This report includes only approved vendors matching the specialty tags selected when it was generated.",
                italics: true,
                margin: [0, 0, 0, 10],
            },
            ...bodyContent,
        ],
    };

    try {
        const blob = await pdfMake.createPdf(docDefinition).getBlob();
        const dateStamp = new Date().toISOString().slice(0, 10);

        await logGeneratedReport(reportIdText, "specialty_custom", {
            approvedCount: matchedVendors.length,
            selections,
        });

        return {
            ok: true,
            blob,
            fileName: `Vender-Specialty-Report-custom-${dateStamp}.pdf`,
            reportId: reportIdText,
            approvedCount: matchedVendors.length,
        };
    } catch (err) {
        console.error("Failed to build custom specialty report:", err);
        return { ok: false, error: "Couldn't build the report file." };
    }
}

/* ===========================
   INIT
=========================== */

window.initCompaniesPage = async function () {

    await loadVendorTagData();
    loadCompanies();

    // Vendor Profile popup
    const closeVendorProfileBtn = document.getElementById("closeVendorProfileBtn");
    if (closeVendorProfileBtn) closeVendorProfileBtn.addEventListener("click", closeVendorProfileModal);

    const vendorProfileOverlay = document.getElementById("vendorProfileModalOverlay");
    if (vendorProfileOverlay) {
        vendorProfileOverlay.addEventListener("click", (event) => {
            if (event.target === vendorProfileOverlay) closeVendorProfileModal();
        });
    }

    const vendorProfileViewContactsBtn = document.getElementById("vendorProfileViewContactsBtn");
    if (vendorProfileViewContactsBtn) {
        vendorProfileViewContactsBtn.addEventListener("click", () => {
            if (!currentProfileCompany) return;
            const company = currentProfileCompany;
            closeVendorProfileModal();
            openContactsModal(company);
        });
    }

    const vendorProfileEditBtn = document.getElementById("vendorProfileEditBtn");
    if (vendorProfileEditBtn) {
        vendorProfileEditBtn.addEventListener("click", () => {
            if (!currentProfileCompany) return;
            const company = currentProfileCompany;
            closeVendorProfileModal();
            openCompanyModal(company);
        });
    }

    // Manage Tags popup
    const manageTagsBtn = document.getElementById("manageTagsBtn");
    if (manageTagsBtn) manageTagsBtn.addEventListener("click", openManageTagsModal);

    const closeManageTagsBtn = document.getElementById("closeManageTagsBtn");
    if (closeManageTagsBtn) closeManageTagsBtn.addEventListener("click", closeManageTagsModal);

    const manageTagsOverlay = document.getElementById("manageTagsModalOverlay");
    if (manageTagsOverlay) {
        manageTagsOverlay.addEventListener("click", (event) => {
            if (event.target === manageTagsOverlay) closeManageTagsModal();
        });
    }

    const addTagCategoryBtn = document.getElementById("addTagCategoryBtn");
    if (addTagCategoryBtn) addTagCategoryBtn.addEventListener("click", addTagCategory);

    const newTagCategoryInput = document.getElementById("newTagCategoryInput");
    if (newTagCategoryInput) {
        newTagCategoryInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); addTagCategory(); }
        });
    }

    // Event delegation for everything inside the categories list, since it's
    // fully re-rendered after every add/rename/delete.
    const manageTagsCategories = document.getElementById("manageTagsCategories");
    if (manageTagsCategories) {
        manageTagsCategories.addEventListener("click", (event) => {
            const renameCatBtn = event.target.closest(".tag-admin-rename-cat");
            if (renameCatBtn) { renameTagCategory(renameCatBtn.dataset.id); return; }

            const deleteCatBtn = event.target.closest(".tag-admin-delete-cat");
            if (deleteCatBtn) { deleteTagCategory(deleteCatBtn.dataset.id); return; }

            const renameTagBtn = event.target.closest(".tag-admin-rename-tag");
            if (renameTagBtn) { renameTag(renameTagBtn.dataset.id); return; }

            const deleteTagBtn = event.target.closest(".tag-admin-delete-tag");
            if (deleteTagBtn) { deleteTag(deleteTagBtn.dataset.id); return; }

            const addTagBtn = event.target.closest(".tag-admin-add-tag-btn");
            if (addTagBtn) {
                const categoryId = addTagBtn.dataset.categoryId;
                const input = manageTagsCategories.querySelector(`.tag-admin-new-tag-input[data-category-id="${categoryId}"]`);
                if (input) addTagToCategory(categoryId, input);
                return;
            }
        });

        manageTagsCategories.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            const input = event.target.closest(".tag-admin-new-tag-input");
            if (!input) return;
            event.preventDefault();
            addTagToCategory(input.dataset.categoryId, input);
        });
    }

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
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener("click", confirmDelete);

    const deleteOverlay = document.getElementById("deleteConfirmOverlay");
    if (deleteOverlay) {
        deleteOverlay.addEventListener("click", (event) => {
            if (event.target === deleteOverlay) closeDeleteConfirm();
        });
    }

    // Contacts list modal
    const closeContactsBtn = document.getElementById("closeContactsBtn");
    if (closeContactsBtn) closeContactsBtn.addEventListener("click", closeContactsModal);

    const contactsOverlay = document.getElementById("contactsModalOverlay");
    if (contactsOverlay) {
        contactsOverlay.addEventListener("click", (event) => {
            if (event.target === contactsOverlay) closeContactsModal();
        });
    }

    const addContactBtn = document.getElementById("addContactBtn");
    if (addContactBtn) {
        addContactBtn.addEventListener("click", () => {
            const companyId = document.getElementById("contactsModalCompanyId").value;
            const companyName = document.getElementById("contactsModalTitle").dataset.companyName || "";
            openContactFormModal(null, companyId, companyName);
        });
    }

    // Contact add/edit modal
    const cancelContactBtn = document.getElementById("cancelContactBtn");
    if (cancelContactBtn) cancelContactBtn.addEventListener("click", closeContactFormModal);

    const contactFormOverlay = document.getElementById("contactModalOverlay");
    if (contactFormOverlay) {
        contactFormOverlay.addEventListener("click", (event) => {
            if (event.target === contactFormOverlay) closeContactFormModal();
        });
    }

    const contactForm = document.getElementById("contactForm");
    if (contactForm) contactForm.addEventListener("submit", handleContactFormSubmit);

    const deleteContactBtn = document.getElementById("deleteContactBtn");
    if (deleteContactBtn) deleteContactBtn.addEventListener("click", openContactDeleteConfirm);

    hideCompanyMessage();
};