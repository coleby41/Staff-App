/* ===========================================================
   ACCOUNTS / CONTACTS (project-accounts.html)

   Two things live on this page:
     1. Project Details — the same wizard-collected fields that used to
        render on projects.html's Overview tab under a "Project Details"
        heading (window.ProjectFields.WIZARD_STEPS, page === "/pages/projects.html",
        minus the "tracking" step which gets its own Status & Tracking card
        here instead). Unchanged data, just moved.
     2. A new lightweight CRM layer — project_contacts / project_organizations
        / project_utility_accounts / project_gov_offices (see SQL FILES/
        supabase-project-accounts-contacts-schema.sql) — deliberately
        separate from the wizard fields above (adding a contact here does
        NOT fill in the wizard's "Property Owner phone" field, etc.).

   Waits for "project-shell:ready" (project-shell.js) to know which project
   we're on, same as every other project-*.html page.
=========================================================== */

(function () {
    "use strict";

    const CONTACTS_TABLE = "project_contacts";
    const ORGANIZATIONS_TABLE = "project_organizations";
    const UTILITY_ACCOUNTS_TABLE = "project_utility_accounts";
    const GOV_OFFICES_TABLE = "project_gov_offices";

    // Page-local type lists (unlike window.ProjectFields.CONTACT_TYPES,
    // these aren't reused anywhere else in the app yet, so they live here
    // rather than in project-fields.js). Keys match the SQL check
    // constraints in supabase-project-accounts-contacts-schema.sql exactly.
    const ORG_TYPES = [
        { key: "general_contractor", label: "General Contractor" },
        { key: "subcontractor", label: "Subcontractor" },
        { key: "vendor", label: "Vendor" },
        { key: "utility_company", label: "Utility Company" },
        { key: "government_agency", label: "Government Agency" },
        { key: "insurance", label: "Insurance" },
        { key: "other", label: "Other" }
    ];

    const UTILITY_TYPES = [
        { key: "electric", label: "Electric" },
        { key: "water", label: "Water" },
        { key: "gas", label: "Gas" },
        { key: "sewer", label: "Sewer" },
        { key: "trash", label: "Trash" },
        { key: "internet", label: "Internet" },
        { key: "cable", label: "Cable" },
        { key: "other", label: "Other" }
    ];

    // The 6 quick-access card types on the Project Details tab — every
    // CONTACT_TYPE except the catch-all "Other" (which only ever shows up
    // in the All Contacts tab / type filter).
    const QUICK_CARD_TYPES = window.ProjectFields.CONTACT_TYPES.filter(t => t.key !== "other");

    let currentProject = null;
    let myProjectRole = null;
    let contacts = [];
    let organizations = [];
    let utilityAccounts = [];
    let govOffices = [];

    let contactCardView = "grid"; // "grid" | "list"
    let pendingDelete = null;     // { table, id, label }
    let editingContactId = null;
    let editingOrganizationId = null;
    let editingUtilityAccountId = null;
    let editingGovOfficeId = null;

    /* ---------- helpers ---------- */

    function escapeHtmlAccounts(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function getAccountsStaffProfile() {
        return window.currentSupabaseProfile
            || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    }

    function getAccountsStaffName() {
        const profile = getAccountsStaffProfile();
        return (profile && (profile.full_name || profile.username)) || "Staff";
    }

    function getAccountsStaffId() {
        const profile = getAccountsStaffProfile();
        return profile?.id || profile?.uid || null;
    }

    function setAccountsPageMessage(text, type) {
        const el = document.getElementById("accountsPageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; return; }
        el.textContent = text;
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = "block";
        if (type === "success") setTimeout(() => { el.style.display = "none"; }, 4000);
    }

    function formatAccountDate(isoString) {
        if (!isoString) return "—";
        try {
            return new Date(isoString).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        } catch {
            return isoString;
        }
    }

    function canManageProject() {
        return myProjectRole === "project_admin" || myProjectRole === "project_manager";
    }

    function canEditRecord(record) {
        return canManageProject() || String(record.created_by) === String(getAccountsStaffId());
    }

    /* ---------- load ---------- */

    async function loadMyProjectRole(projectId) {
        const { data, error } = await window.supabaseClient.rpc("project_role", { p_project_id: projectId });
        if (error) { console.error("Failed to resolve project role:", error); myProjectRole = null; return; }
        myProjectRole = data;
    }

    async function loadAllAccountsData(projectId) {
        const [contactsRes, orgsRes, utilRes, govRes] = await Promise.all([
            window.supabaseClient.from(CONTACTS_TABLE).select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
            window.supabaseClient.from(ORGANIZATIONS_TABLE).select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
            window.supabaseClient.from(UTILITY_ACCOUNTS_TABLE).select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
            window.supabaseClient.from(GOV_OFFICES_TABLE).select("*").eq("project_id", projectId).order("created_at", { ascending: true })
        ]);

        if (contactsRes.error) console.error("Failed to load contacts:", contactsRes.error);
        if (orgsRes.error) console.error("Failed to load organizations:", orgsRes.error);
        if (utilRes.error) console.error("Failed to load utility accounts:", utilRes.error);
        if (govRes.error) console.error("Failed to load government offices:", govRes.error);

        contacts = contactsRes.data || [];
        organizations = orgsRes.data || [];
        utilityAccounts = utilRes.data || [];
        govOffices = govRes.data || [];
    }

    function getRecordArray(table) {
        if (table === CONTACTS_TABLE) return contacts;
        if (table === ORGANIZATIONS_TABLE) return organizations;
        if (table === UTILITY_ACCOUNTS_TABLE) return utilityAccounts;
        if (table === GOV_OFFICES_TABLE) return govOffices;
        return [];
    }

    function findRecord(table, id) {
        return getRecordArray(table).find(r => String(r.id) === String(id)) || null;
    }

    /* ---------- Project Details tab: wizard-field grid (moved from
       projects.html unchanged, minus the "tracking" step) ---------- */

    // step key -> icon/color, matched 1:1 against the mockup's card badges
    // and reusing the same icon/color pairs as the overlapping
    // window.ProjectFields.CONTACT_TYPES entries (owner_contact/gc/poc/
    // utilities/temp_services/county_city) so a "General Contractor" badge
    // looks the same here as it does on the Project Contacts quick-cards.
    // job_name and site_address have no CONTACT_TYPES counterpart, so they
    // get their own pairing (briefcase/success, pin/info).
    const PROJECT_DETAILS_STEP_ICONS = {
        owner_contact: { icon: "person", color: "accent" },
        job_name: { icon: "briefcase", color: "success" },
        site_address: { icon: "pin", color: "info" },
        gc: { icon: "building", color: "info" },
        poc: { icon: "badge", color: "success" },
        utilities: { icon: "droplet", color: "info" },
        temp_services: { icon: "trash", color: "completed" },
        county_city: { icon: "bank", color: "accent" }
    };

    // One .pd-card, given its own anchor field (for sidebar-search
    // highlightHashTarget()), icon/color, title, and pre-built row HTML.
    function pdCardHtml(anchorFieldName, icon, color, title, rowsHtml) {
        return `
            <div class="pd-card" id="field-${anchorFieldName}">
                <div class="pd-card-header">
                    <span class="project-stat-icon project-stat-icon--${color} project-stat-icon--${icon}"></span>
                    <h3 class="pd-card-title">${escapeHtmlAccounts(title)}</h3>
                </div>
                ${rowsHtml || `<p class="pd-empty-note">Nothing on file yet.</p>`}
            </div>
        `;
    }

    function pdFieldRow(label, value) {
        return `
            <div class="pd-field-row">
                ${label ? `<span class="pd-field-label">${escapeHtmlAccounts(label)}</span>` : ""}
                ${escapeHtmlAccounts(value)}
            </div>
        `;
    }

    function renderProjectDetailsGrid(project) {
        const grid = document.getElementById("accountsSummaryGrid");
        if (!grid) return;

        const steps = window.ProjectFields.WIZARD_STEPS.filter(step => step.page === "/pages/projects.html" && step.key !== "tracking");

        grid.innerHTML = steps.map(step => {
            const meta = PROJECT_DETAILS_STEP_ICONS[step.key] || { icon: "person", color: "accent" };

            // Job Site Address: one combined "Street, City, State, Zip" line
            // instead of 4 separate labeled rows.
            if (step.key === "site_address") {
                const combined = [project.site_address, project.site_city, project.site_state, project.site_zip]
                    .filter(v => !window.ProjectFields.isBlank(v))
                    .join(", ");
                const rows = combined ? pdFieldRow(null, combined) : "";
                return pdCardHtml(step.fields[0].name, meta.icon, meta.color, step.title, rows);
            }

            // Trash and Porta Potties are two separate real-world vendor
            // accounts — split into their own cards instead of one combined
            // "Temporary Trash / Porta Potties" card (Coleby's follow-up ask).
            if (step.key === "temp_services") {
                const trashFields = step.fields.filter(f => f.name.startsWith("trash_"));
                const pottyFields = step.fields.filter(f => f.name.startsWith("porta_potty_"));
                const notesField = step.fields.find(f => f.name === "temp_services_notes");

                const fieldRows = (fields) => fields.map(field => {
                    const raw = project[field.name];
                    return window.ProjectFields.isBlank(raw) ? "" : pdFieldRow(field.label, raw);
                }).filter(Boolean).join("");

                const notesRow = notesField && !window.ProjectFields.isBlank(project[notesField.name])
                    ? pdFieldRow(notesField.label, project[notesField.name])
                    : "";

                return [
                    pdCardHtml(trashFields[0].name, "trash", "completed", "Trash", fieldRows(trashFields) + notesRow),
                    pdCardHtml(pottyFields[0].name, "droplet", "completed", "Porta Potties", fieldRows(pottyFields))
                ].join("");
            }

            // Electric and Water are two separate real-world utility
            // accounts — split into their own cards instead of one combined
            // "Utilities Account Info" card (same split as Trash/Porta
            // Potties above, same reasoning).
            if (step.key === "utilities") {
                const electricFields = step.fields.filter(f => f.name.startsWith("electric_"));
                const waterFields = step.fields.filter(f => f.name.startsWith("water_"));
                const notesField = step.fields.find(f => f.name === "other_utilities_notes");

                const fieldRows = (fields) => fields.map(field => {
                    const raw = project[field.name];
                    return window.ProjectFields.isBlank(raw) ? "" : pdFieldRow(field.label, raw);
                }).filter(Boolean).join("");

                const notesRow = notesField && !window.ProjectFields.isBlank(project[notesField.name])
                    ? pdFieldRow(notesField.label, project[notesField.name])
                    : "";

                return [
                    pdCardHtml(electricFields[0].name, "bolt", "accent", "Electric", fieldRows(electricFields) + notesRow),
                    pdCardHtml(waterFields[0].name, "droplet", "info", "Water", fieldRows(waterFields))
                ].join("");
            }

            // The 4 "contact" steps (owner_contact/gc/poc/county_city) only
            // show the primary name field on this page — no role, phone,
            // email, or address. Full contact details live in the Project
            // Contacts panel/All Contacts tab instead.
            if (step.layout === "contact") {
                const nameField = step.fields[0];
                const raw = project[nameField.name];
                const rows = window.ProjectFields.isBlank(raw) ? "" : pdFieldRow(null, raw);
                return pdCardHtml(nameField.name, meta.icon, meta.color, step.title, rows);
            }

            const rows = step.fields.map(field => {
                const key = field.type === "file" ? field.pathField : field.name;
                const raw = project[key];
                if (window.ProjectFields.isBlank(raw)) return "";
                const value = field.type === "file" ? String(raw).split("/").pop() : raw;
                return pdFieldRow(field.label, value);
            }).filter(Boolean).join("");

            return pdCardHtml(step.fields[0].name, meta.icon, meta.color, step.title, rows);
        }).join("");
    }

    /* ---------- Status & Tracking card ---------- */

    function renderStatusCard(project) {
        const coverEl = document.getElementById("accountStatusCover");
        const detailsEl = document.getElementById("accountStatusDetails");
        if (!coverEl || !detailsEl) return;

        coverEl.innerHTML = project.cover_photo_url
            ? `<img src="${escapeHtmlAccounts(project.cover_photo_url)}" alt="Cover photo">`
            : `<div class="account-status-cover-placeholder">No cover photo on file.</div>`;

        const statusMeta = (window.ProjectFields.PROJECT_STATUSES || []).find(s => s.value === (project.status || "onboarding"));
        const progress = Math.max(0, Math.min(100, Number(project.progress_percent) || 0));

        detailsEl.innerHTML = `
            <div class="account-status-details-row">
                <span class="company-card-label">Status</span>
                <span class="chip ${statusMeta ? statusMeta.chip : "chip--muted"}">${escapeHtmlAccounts(statusMeta ? statusMeta.label : "Unknown")}</span>
            </div>
            <div class="account-status-details-row">
                <span class="company-card-label">Project Manager</span>
                ${window.ProjectFields.isBlank(project.project_manager_name) ? `<p class="project-summary-empty-note">Nothing on file yet.</p>` : escapeHtmlAccounts(project.project_manager_name)}
            </div>
            <div class="account-status-details-row">
                <span class="company-card-label">Progress (%)</span>
                <div class="account-status-progress-value">${progress}%</div>
                <div class="project-progress-track">
                    <span class="project-progress-fill project-progress-fill--${escapeHtmlAccounts(project.status || "onboarding")}" style="width:${progress}%"></span>
                </div>
            </div>
        `;
    }

    /* ---------- type <select> population ---------- */

    function populateTypeSelect(selectEl, types, includeBlankAll, blankLabel) {
        if (!selectEl) return;
        const optionsHtml = types.map(t => `<option value="${escapeHtmlAccounts(t.key)}">${escapeHtmlAccounts(t.label)}</option>`).join("");
        selectEl.innerHTML = (includeBlankAll ? `<option value="">${escapeHtmlAccounts(blankLabel || "All Types")}</option>` : "") + optionsHtml;
    }

    function initTypeSelects() {
        populateTypeSelect(document.getElementById("contactFormType"), window.ProjectFields.CONTACT_TYPES, false);
        populateTypeSelect(document.getElementById("contactCardTypeFilter"), window.ProjectFields.CONTACT_TYPES, true);
        populateTypeSelect(document.getElementById("allContactsTypeFilter"), window.ProjectFields.CONTACT_TYPES, true);
        populateTypeSelect(document.getElementById("organizationFormType"), ORG_TYPES, false);
        populateTypeSelect(document.getElementById("organizationsTypeFilter"), ORG_TYPES, true);
        populateTypeSelect(document.getElementById("utilityAccountFormType"), UTILITY_TYPES, false);
        populateTypeSelect(document.getElementById("utilityAccountsTypeFilter"), UTILITY_TYPES, true);
    }

    /* ---------- Project Contacts quick-access cards ---------- */

    function filteredQuickCardContacts(typeKey) {
        return contacts
            .filter(c => c.contact_type === typeKey)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }

    function contactMatchesSearch(contact, query) {
        if (!query) return true;
        const haystack = [contact.full_name, contact.company_name, contact.title, contact.phone, contact.email].filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(query.toLowerCase());
    }

    function renderContactQuickCards() {
        const grid = document.getElementById("accountContactGrid");
        if (!grid) return;

        const search = (document.getElementById("contactCardSearchInput")?.value || "").trim();
        const typeFilter = document.getElementById("contactCardTypeFilter")?.value || "";
        const sortDir = document.getElementById("contactCardSort")?.value || "az";

        grid.style.gridTemplateColumns = contactCardView === "list" ? "1fr" : "";

        let types = QUICK_CARD_TYPES.slice();
        if (typeFilter) types = types.filter(t => t.key === typeFilter);
        types = types.sort((a, b) => sortDir === "za" ? b.label.localeCompare(a.label) : a.label.localeCompare(b.label));

        grid.innerHTML = types.map(type => {
            const all = filteredQuickCardContacts(type.key);
            const matching = search ? all.filter(c => contactMatchesSearch(c, search)) : all;

            const header = `
                <div class="account-contact-card-header">
                    <span class="project-stat-icon project-stat-icon--${type.color} project-stat-icon--${type.icon}"></span>
                    <span class="account-contact-card-title">${escapeHtmlAccounts(type.label)}</span>
                </div>
            `;

            if (matching.length === 0) {
                return `
                    <div class="account-contact-card" data-type="${escapeHtmlAccounts(type.key)}">
                        ${header}
                        <div class="account-contact-card-body">
                            <button type="button" class="account-contact-add-link" data-action="quick-add" data-type="${escapeHtmlAccounts(type.key)}">+ Add Contact</button>
                        </div>
                    </div>
                `;
            }

            const primary = matching[0];
            const moreCount = matching.length - 1;

            return `
                <div class="account-contact-card" data-type="${escapeHtmlAccounts(type.key)}">
                    ${header}
                    <div class="account-contact-card-menu-wrap">
                        <button type="button" class="all-files-file-menu-btn account-contact-card-menu-btn" data-action="menu" data-table="${CONTACTS_TABLE}" data-id="${escapeHtmlAccounts(primary.id)}" aria-label="Contact actions" aria-haspopup="true" aria-expanded="false">
                            <span class="all-files-file-menu-icon"></span>
                        </button>
                        <div class="all-files-file-menu-dropdown" data-menu-dropdown>
                            <button type="button" class="all-files-file-menu-item" data-action="edit" data-table="${CONTACTS_TABLE}" data-id="${escapeHtmlAccounts(primary.id)}">Edit</button>
                            <button type="button" class="all-files-file-menu-item all-files-file-menu-item--danger" data-action="delete" data-table="${CONTACTS_TABLE}" data-id="${escapeHtmlAccounts(primary.id)}">Delete</button>
                        </div>
                    </div>
                    <div class="account-contact-card-body">
                        <div class="account-contact-name">${escapeHtmlAccounts(primary.full_name)}</div>
                        ${moreCount > 0 ? `<button type="button" class="account-contact-add-link account-contact-more-note" data-action="view-type" data-type="${escapeHtmlAccounts(type.key)}">+${moreCount} more · View all</button>` : ""}
                    </div>
                </div>
            `;
        }).join("");
    }

    /* ---------- generic "⋯" menu handling (contact cards + all 4 lists) ---------- */

    function closeAllAccountMenus() {
        document.querySelectorAll(".all-files-file-menu-dropdown.is-open").forEach(d => d.classList.remove("is-open"));
        document.querySelectorAll(".all-files-file-menu-btn.is-open").forEach(b => { b.classList.remove("is-open"); b.setAttribute("aria-expanded", "false"); });
    }

    function toggleMenuFor(btn) {
        const dropdown = btn.parentElement.querySelector("[data-menu-dropdown]") || btn.nextElementSibling;
        const isOpen = dropdown.classList.contains("is-open");
        closeAllAccountMenus();
        if (!isOpen) {
            dropdown.classList.add("is-open");
            btn.classList.add("is-open");
            btn.setAttribute("aria-expanded", "true");
        }
    }

    document.addEventListener("click", (e) => {
        if (!e.target.closest("[data-action='menu']") && !e.target.closest("[data-menu-dropdown]")) {
            closeAllAccountMenus();
        }
    });

    /* ---------- record row builder (shared by All Contacts / Organizations /
       Utility Accounts / Government Offices) ---------- */

    function recordRowHtml({ table, id, primary, secondary, tertiary, addedBy, addedAt, canEdit }) {
        return `
            <div class="all-files-file-row" data-table="${escapeHtmlAccounts(table)}" data-id="${escapeHtmlAccounts(id)}">
                <div class="all-files-file-name-cell">
                    <div class="all-files-file-name-text">
                        <div class="all-files-file-name-main">${escapeHtmlAccounts(primary)}</div>
                    </div>
                </div>
                <div class="all-files-file-kind-cell">${escapeHtmlAccounts(secondary || "—")}</div>
                <div class="all-files-file-added-by-cell">${escapeHtmlAccounts(tertiary || "—")}</div>
                <div class="all-files-file-date-cell">${escapeHtmlAccounts(addedBy ? `${addedBy} · ${addedAt}` : addedAt)}</div>
                <div class="all-files-file-actions-cell">
                    <button type="button" class="all-files-file-menu-btn" data-action="menu" data-table="${escapeHtmlAccounts(table)}" data-id="${escapeHtmlAccounts(id)}" aria-label="Actions" aria-haspopup="true" aria-expanded="false">
                        <span class="all-files-file-menu-icon"></span>
                    </button>
                    <div class="all-files-file-menu-dropdown" data-menu-dropdown>
                        <button type="button" class="all-files-file-menu-item" data-action="edit" data-table="${escapeHtmlAccounts(table)}" data-id="${escapeHtmlAccounts(id)}">Edit</button>
                        ${canEdit ? `<button type="button" class="all-files-file-menu-item all-files-file-menu-item--danger" data-action="delete" data-table="${escapeHtmlAccounts(table)}" data-id="${escapeHtmlAccounts(id)}">Delete</button>` : ""}
                    </div>
                </div>
            </div>
        `;
    }

    function renderAllContactsList() {
        const listEl = document.getElementById("allContactsList");
        const emptyEl = document.getElementById("allContactsEmpty");
        if (!listEl) return;

        const search = (document.getElementById("allContactsSearchInput")?.value || "").trim();
        const typeFilter = document.getElementById("allContactsTypeFilter")?.value || "";
        const sortBy = document.getElementById("allContactsSort")?.value || "az";

        let rows = contacts.slice();
        if (typeFilter) rows = rows.filter(c => c.contact_type === typeFilter);
        if (search) rows = rows.filter(c => contactMatchesSearch(c, search));

        rows.sort((a, b) => {
            if (sortBy === "newest") return new Date(b.created_at) - new Date(a.created_at);
            const cmp = (a.full_name || "").localeCompare(b.full_name || "");
            return sortBy === "za" ? -cmp : cmp;
        });

        emptyEl.style.display = rows.length ? "none" : "block";

        listEl.innerHTML = rows.map(c => recordRowHtml({
            table: CONTACTS_TABLE,
            id: c.id,
            primary: c.full_name,
            secondary: window.ProjectFields.contactTypeMeta(c.contact_type).label,
            tertiary: [c.phone, c.email].filter(Boolean).join(" / ") || "—",
            addedBy: c.created_by_name,
            addedAt: formatAccountDate(c.created_at),
            canEdit: canEditRecord(c)
        })).join("");
    }

    function renderOrganizationsList() {
        const listEl = document.getElementById("organizationsList");
        const emptyEl = document.getElementById("organizationsEmpty");
        if (!listEl) return;

        const search = (document.getElementById("organizationsSearchInput")?.value || "").trim().toLowerCase();
        const typeFilter = document.getElementById("organizationsTypeFilter")?.value || "";

        let rows = organizations.slice();
        if (typeFilter) rows = rows.filter(o => o.org_type === typeFilter);
        if (search) rows = rows.filter(o => [o.org_name, o.phone, o.email, o.website].filter(Boolean).join(" ").toLowerCase().includes(search));
        rows.sort((a, b) => (a.org_name || "").localeCompare(b.org_name || ""));

        emptyEl.style.display = rows.length ? "none" : "block";

        const typeLabel = key => (ORG_TYPES.find(t => t.key === key) || {}).label || key;

        listEl.innerHTML = rows.map(o => recordRowHtml({
            table: ORGANIZATIONS_TABLE,
            id: o.id,
            primary: o.org_name,
            secondary: typeLabel(o.org_type),
            tertiary: [o.phone, o.website].filter(Boolean).join(" / ") || "—",
            addedBy: o.created_by_name,
            addedAt: formatAccountDate(o.created_at),
            canEdit: canEditRecord(o)
        })).join("");
    }

    function renderUtilityAccountsList() {
        const listEl = document.getElementById("utilityAccountsList");
        const emptyEl = document.getElementById("utilityAccountsEmpty");
        if (!listEl) return;

        const search = (document.getElementById("utilityAccountsSearchInput")?.value || "").trim().toLowerCase();
        const typeFilter = document.getElementById("utilityAccountsTypeFilter")?.value || "";

        let rows = utilityAccounts.slice();
        if (typeFilter) rows = rows.filter(u => u.utility_type === typeFilter);
        if (search) rows = rows.filter(u => [u.provider_name, u.account_number, u.phone].filter(Boolean).join(" ").toLowerCase().includes(search));
        rows.sort((a, b) => (a.provider_name || "").localeCompare(b.provider_name || ""));

        emptyEl.style.display = rows.length ? "none" : "block";

        const typeLabel = key => (UTILITY_TYPES.find(t => t.key === key) || {}).label || key;

        listEl.innerHTML = rows.map(u => recordRowHtml({
            table: UTILITY_ACCOUNTS_TABLE,
            id: u.id,
            primary: u.provider_name,
            secondary: typeLabel(u.utility_type),
            tertiary: u.account_number || "—",
            addedBy: u.created_by_name,
            addedAt: formatAccountDate(u.created_at),
            canEdit: canEditRecord(u)
        })).join("");
    }

    function renderGovOfficesList() {
        const listEl = document.getElementById("govOfficesList");
        const emptyEl = document.getElementById("govOfficesEmpty");
        if (!listEl) return;

        const search = (document.getElementById("govOfficesSearchInput")?.value || "").trim().toLowerCase();

        let rows = govOffices.slice();
        if (search) rows = rows.filter(g => [g.office_name, g.department, g.jurisdiction, g.contact_name, g.phone].filter(Boolean).join(" ").toLowerCase().includes(search));
        rows.sort((a, b) => (a.office_name || "").localeCompare(b.office_name || ""));

        emptyEl.style.display = rows.length ? "none" : "block";

        listEl.innerHTML = rows.map(g => recordRowHtml({
            table: GOV_OFFICES_TABLE,
            id: g.id,
            primary: g.office_name,
            secondary: [g.department, g.jurisdiction].filter(Boolean).join(" · ") || "—",
            tertiary: g.phone || "—",
            addedBy: g.created_by_name,
            addedAt: formatAccountDate(g.created_at),
            canEdit: canEditRecord(g)
        })).join("");
    }

    function renderAll() {
        renderContactQuickCards();
        renderAllContactsList();
        renderOrganizationsList();
        renderUtilityAccountsList();
        renderGovOfficesList();
    }

    /* ---------- tabs ---------- */

    function switchTab(tabKey) {
        document.querySelectorAll(".dash-tab[data-tab]").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabKey));
        document.querySelectorAll(".accounts-tab-panel[data-tab-panel]").forEach(panel => panel.classList.toggle("hidden", panel.dataset.tabPanel !== tabKey));
    }

    function wireTabs() {
        document.querySelectorAll(".dash-tab[data-tab]").forEach(btn => {
            btn.addEventListener("click", () => switchTab(btn.dataset.tab));
        });
    }

    /* ---------- Contact modal ---------- */

    function openContactModal(presetType, existing) {
        editingContactId = existing ? existing.id : null;
        document.getElementById("contactModalTitle").textContent = existing ? "Edit Contact" : "Add Contact";
        document.getElementById("contactFormType").value = existing ? existing.contact_type : (presetType || window.ProjectFields.CONTACT_TYPES[0].key);
        document.getElementById("contactFormName").value = existing ? existing.full_name || "" : "";
        document.getElementById("contactFormTitle").value = existing ? existing.title || "" : "";
        document.getElementById("contactFormCompany").value = existing ? existing.company_name || "" : "";
        document.getElementById("contactFormPhone").value = existing ? existing.phone || "" : "";
        document.getElementById("contactFormEmail").value = existing ? existing.email || "" : "";
        document.getElementById("contactFormNotes").value = existing ? existing.notes || "" : "";
        document.getElementById("contactFormMessage").textContent = "";
        document.getElementById("contactModalOverlay").classList.remove("hidden");
        document.getElementById("contactFormName").focus();
    }

    function closeContactModal() {
        document.getElementById("contactModalOverlay").classList.add("hidden");
        editingContactId = null;
    }

    async function submitContactForm(event) {
        event.preventDefault();
        const msgEl = document.getElementById("contactFormMessage");
        const payload = {
            project_id: currentProject.id,
            contact_type: document.getElementById("contactFormType").value,
            full_name: document.getElementById("contactFormName").value.trim(),
            title: document.getElementById("contactFormTitle").value.trim() || null,
            company_name: document.getElementById("contactFormCompany").value.trim() || null,
            phone: document.getElementById("contactFormPhone").value.trim() || null,
            email: document.getElementById("contactFormEmail").value.trim() || null,
            notes: document.getElementById("contactFormNotes").value.trim() || null
        };
        if (!payload.full_name) { msgEl.textContent = "Name is required."; return; }

        const query = editingContactId
            ? window.supabaseClient.from(CONTACTS_TABLE).update(payload).eq("id", editingContactId).select().single()
            : window.supabaseClient.from(CONTACTS_TABLE).insert(payload).select().single();

        const { data, error } = await query;
        if (error) { msgEl.textContent = error.message || "Couldn't save this contact."; return; }

        if (editingContactId) {
            contacts = contacts.map(c => c.id === data.id ? data : c);
        } else {
            contacts.push(data);
        }
        closeContactModal();
        renderContactQuickCards();
        renderAllContactsList();
        setAccountsPageMessage("Contact saved.", "success");
    }

    /* ---------- Organization modal ---------- */

    function openOrganizationModal(existing) {
        editingOrganizationId = existing ? existing.id : null;
        document.getElementById("organizationModalTitle").textContent = existing ? "Edit Organization" : "Add Organization";
        document.getElementById("organizationFormName").value = existing ? existing.org_name || "" : "";
        document.getElementById("organizationFormType").value = existing ? existing.org_type : ORG_TYPES[0].key;
        document.getElementById("organizationFormPhone").value = existing ? existing.phone || "" : "";
        document.getElementById("organizationFormEmail").value = existing ? existing.email || "" : "";
        document.getElementById("organizationFormWebsite").value = existing ? existing.website || "" : "";
        document.getElementById("organizationFormAddress").value = existing ? existing.address || "" : "";
        document.getElementById("organizationFormNotes").value = existing ? existing.notes || "" : "";
        document.getElementById("organizationFormMessage").textContent = "";
        document.getElementById("organizationModalOverlay").classList.remove("hidden");
        document.getElementById("organizationFormName").focus();
    }

    function closeOrganizationModal() {
        document.getElementById("organizationModalOverlay").classList.add("hidden");
        editingOrganizationId = null;
    }

    async function submitOrganizationForm(event) {
        event.preventDefault();
        const msgEl = document.getElementById("organizationFormMessage");
        const payload = {
            project_id: currentProject.id,
            org_name: document.getElementById("organizationFormName").value.trim(),
            org_type: document.getElementById("organizationFormType").value,
            phone: document.getElementById("organizationFormPhone").value.trim() || null,
            email: document.getElementById("organizationFormEmail").value.trim() || null,
            website: document.getElementById("organizationFormWebsite").value.trim() || null,
            address: document.getElementById("organizationFormAddress").value.trim() || null,
            notes: document.getElementById("organizationFormNotes").value.trim() || null
        };
        if (!payload.org_name) { msgEl.textContent = "Organization name is required."; return; }

        const query = editingOrganizationId
            ? window.supabaseClient.from(ORGANIZATIONS_TABLE).update(payload).eq("id", editingOrganizationId).select().single()
            : window.supabaseClient.from(ORGANIZATIONS_TABLE).insert(payload).select().single();

        const { data, error } = await query;
        if (error) { msgEl.textContent = error.message || "Couldn't save this organization."; return; }

        if (editingOrganizationId) {
            organizations = organizations.map(o => o.id === data.id ? data : o);
        } else {
            organizations.push(data);
        }
        closeOrganizationModal();
        renderOrganizationsList();
        setAccountsPageMessage("Organization saved.", "success");
    }

    /* ---------- Utility Account modal ---------- */

    function openUtilityAccountModal(existing) {
        editingUtilityAccountId = existing ? existing.id : null;
        document.getElementById("utilityAccountModalTitle").textContent = existing ? "Edit Utility Account" : "Add Utility Account";
        document.getElementById("utilityAccountFormType").value = existing ? existing.utility_type : UTILITY_TYPES[0].key;
        document.getElementById("utilityAccountFormProvider").value = existing ? existing.provider_name || "" : "";
        document.getElementById("utilityAccountFormNumber").value = existing ? existing.account_number || "" : "";
        document.getElementById("utilityAccountFormPhone").value = existing ? existing.phone || "" : "";
        document.getElementById("utilityAccountFormNotes").value = existing ? existing.notes || "" : "";
        document.getElementById("utilityAccountFormMessage").textContent = "";
        document.getElementById("utilityAccountModalOverlay").classList.remove("hidden");
        document.getElementById("utilityAccountFormProvider").focus();
    }

    function closeUtilityAccountModal() {
        document.getElementById("utilityAccountModalOverlay").classList.add("hidden");
        editingUtilityAccountId = null;
    }

    async function submitUtilityAccountForm(event) {
        event.preventDefault();
        const msgEl = document.getElementById("utilityAccountFormMessage");
        const payload = {
            project_id: currentProject.id,
            utility_type: document.getElementById("utilityAccountFormType").value,
            provider_name: document.getElementById("utilityAccountFormProvider").value.trim(),
            account_number: document.getElementById("utilityAccountFormNumber").value.trim() || null,
            phone: document.getElementById("utilityAccountFormPhone").value.trim() || null,
            notes: document.getElementById("utilityAccountFormNotes").value.trim() || null
        };
        if (!payload.provider_name) { msgEl.textContent = "Provider name is required."; return; }

        const query = editingUtilityAccountId
            ? window.supabaseClient.from(UTILITY_ACCOUNTS_TABLE).update(payload).eq("id", editingUtilityAccountId).select().single()
            : window.supabaseClient.from(UTILITY_ACCOUNTS_TABLE).insert(payload).select().single();

        const { data, error } = await query;
        if (error) { msgEl.textContent = error.message || "Couldn't save this utility account."; return; }

        if (editingUtilityAccountId) {
            utilityAccounts = utilityAccounts.map(u => u.id === data.id ? data : u);
        } else {
            utilityAccounts.push(data);
        }
        closeUtilityAccountModal();
        renderUtilityAccountsList();
        setAccountsPageMessage("Utility account saved.", "success");
    }

    /* ---------- Government Office modal ---------- */

    function openGovOfficeModal(existing) {
        editingGovOfficeId = existing ? existing.id : null;
        document.getElementById("govOfficeModalTitle").textContent = existing ? "Edit Government / Office" : "Add Government / Office";
        document.getElementById("govOfficeFormName").value = existing ? existing.office_name || "" : "";
        document.getElementById("govOfficeFormDepartment").value = existing ? existing.department || "" : "";
        document.getElementById("govOfficeFormJurisdiction").value = existing ? existing.jurisdiction || "" : "";
        document.getElementById("govOfficeFormContactName").value = existing ? existing.contact_name || "" : "";
        document.getElementById("govOfficeFormPhone").value = existing ? existing.phone || "" : "";
        document.getElementById("govOfficeFormEmail").value = existing ? existing.email || "" : "";
        document.getElementById("govOfficeFormAddress").value = existing ? existing.address || "" : "";
        document.getElementById("govOfficeFormNotes").value = existing ? existing.notes || "" : "";
        document.getElementById("govOfficeFormMessage").textContent = "";
        document.getElementById("govOfficeModalOverlay").classList.remove("hidden");
        document.getElementById("govOfficeFormName").focus();
    }

    function closeGovOfficeModal() {
        document.getElementById("govOfficeModalOverlay").classList.add("hidden");
        editingGovOfficeId = null;
    }

    async function submitGovOfficeForm(event) {
        event.preventDefault();
        const msgEl = document.getElementById("govOfficeFormMessage");
        const payload = {
            project_id: currentProject.id,
            office_name: document.getElementById("govOfficeFormName").value.trim(),
            department: document.getElementById("govOfficeFormDepartment").value.trim() || null,
            jurisdiction: document.getElementById("govOfficeFormJurisdiction").value.trim() || null,
            contact_name: document.getElementById("govOfficeFormContactName").value.trim() || null,
            phone: document.getElementById("govOfficeFormPhone").value.trim() || null,
            email: document.getElementById("govOfficeFormEmail").value.trim() || null,
            address: document.getElementById("govOfficeFormAddress").value.trim() || null,
            notes: document.getElementById("govOfficeFormNotes").value.trim() || null
        };
        if (!payload.office_name) { msgEl.textContent = "Office name is required."; return; }

        const query = editingGovOfficeId
            ? window.supabaseClient.from(GOV_OFFICES_TABLE).update(payload).eq("id", editingGovOfficeId).select().single()
            : window.supabaseClient.from(GOV_OFFICES_TABLE).insert(payload).select().single();

        const { data, error } = await query;
        if (error) { msgEl.textContent = error.message || "Couldn't save this office."; return; }

        if (editingGovOfficeId) {
            govOffices = govOffices.map(g => g.id === data.id ? data : g);
        } else {
            govOffices.push(data);
        }
        closeGovOfficeModal();
        renderGovOfficesList();
        setAccountsPageMessage("Office saved.", "success");
    }

    /* ---------- Delete confirm (shared) ---------- */

    function recordLabel(table, record) {
        if (table === CONTACTS_TABLE) return record.full_name;
        if (table === ORGANIZATIONS_TABLE) return record.org_name;
        if (table === UTILITY_ACCOUNTS_TABLE) return record.provider_name;
        if (table === GOV_OFFICES_TABLE) return record.office_name;
        return "this record";
    }

    let pendingDeleteName = "";

    // Typing the record's own name to confirm (same pattern used for
    // project deletion) -- cheap insurance against a one-click delete
    // landing on the wrong contact/organization/account/office, which is
    // otherwise unrecoverable.
    function deleteRecordConfirmNameMatches() {
        const typed = document.getElementById("deleteRecordConfirmNameInput").value;
        return pendingDeleteName.length > 0 && typed.trim() === pendingDeleteName;
    }

    function deleteRecordConfirmReady() {
        return deleteRecordConfirmNameMatches()
            && document.getElementById("deleteRecordConfirmUnderstandCheckbox").checked;
    }

    function updateDeleteRecordConfirmBtnState() {
        document.getElementById("confirmDeleteRecordBtn").disabled = !deleteRecordConfirmReady();
    }

    function openDeleteRecordConfirm(table, id) {
        const record = findRecord(table, id);
        if (!record) return;
        pendingDelete = { table, id };
        pendingDeleteName = recordLabel(table, record) || "";
        document.getElementById("deleteRecordConfirmName").textContent = pendingDeleteName || "this record";
        document.getElementById("deleteRecordConfirmMessage").textContent = "";
        const input = document.getElementById("deleteRecordConfirmNameInput");
        input.value = "";
        document.getElementById("deleteRecordConfirmUnderstandCheckbox").checked = false;
        document.getElementById("deleteRecordConfirmOverlay").classList.remove("hidden");
        updateDeleteRecordConfirmBtnState();
        input.focus();
    }

    function closeDeleteRecordConfirm() {
        document.getElementById("deleteRecordConfirmOverlay").classList.add("hidden");
        pendingDelete = null;
        pendingDeleteName = "";
    }

    async function confirmDeleteRecord() {
        if (!pendingDelete) return;
        if (!deleteRecordConfirmReady()) return;
        const { table, id } = pendingDelete;
        const { error } = await window.supabaseClient.from(table).delete().eq("id", id);
        if (error) {
            setAccountsPageMessage(error.message || "Couldn't delete this record.", "error");
            closeDeleteRecordConfirm();
            return;
        }

        if (table === CONTACTS_TABLE) contacts = contacts.filter(r => r.id !== id);
        if (table === ORGANIZATIONS_TABLE) organizations = organizations.filter(r => r.id !== id);
        if (table === UTILITY_ACCOUNTS_TABLE) utilityAccounts = utilityAccounts.filter(r => r.id !== id);
        if (table === GOV_OFFICES_TABLE) govOffices = govOffices.filter(r => r.id !== id);

        closeDeleteRecordConfirm();
        renderAll();
        setAccountsPageMessage("Deleted.", "success");
    }

    /* ---------- delegated click handling for menus / row actions / quick-add ---------- */

    function handleGlobalClick(event) {
        const menuBtn = event.target.closest("[data-action='menu']");
        if (menuBtn) {
            event.stopPropagation();
            toggleMenuFor(menuBtn);
            return;
        }

        const quickAddBtn = event.target.closest("[data-action='quick-add']");
        if (quickAddBtn) {
            openContactModal(quickAddBtn.dataset.type, null);
            return;
        }

        const viewTypeBtn = event.target.closest("[data-action='view-type']");
        if (viewTypeBtn) {
            switchTab("contacts");
            const filterEl = document.getElementById("allContactsTypeFilter");
            if (filterEl) { filterEl.value = viewTypeBtn.dataset.type; renderAllContactsList(); }
            return;
        }

        const editBtn = event.target.closest("[data-action='edit']");
        if (editBtn) {
            closeAllAccountMenus();
            const { table, id } = editBtn.dataset;
            const record = findRecord(table, id);
            if (!record) return;
            if (table === CONTACTS_TABLE) openContactModal(null, record);
            else if (table === ORGANIZATIONS_TABLE) openOrganizationModal(record);
            else if (table === UTILITY_ACCOUNTS_TABLE) openUtilityAccountModal(record);
            else if (table === GOV_OFFICES_TABLE) openGovOfficeModal(record);
            return;
        }

        const deleteBtn = event.target.closest("[data-action='delete']");
        if (deleteBtn) {
            closeAllAccountMenus();
            const { table, id } = deleteBtn.dataset;
            const record = findRecord(table, id);
            if (record && !canEditRecord(record)) {
                setAccountsPageMessage("Only the person who added this, or project leadership, can delete it.", "error");
                return;
            }
            openDeleteRecordConfirm(table, id);
        }
    }

    /* ---------- view toggle (grid/list) for the quick-access cards ---------- */

    function wireContactCardViewToggle() {
        const gridBtn = document.getElementById("contactCardGridBtn");
        const listBtn = document.getElementById("contactCardListBtn");
        const toggle = document.getElementById("contactCardViewToggle");
        if (!gridBtn || !listBtn || !toggle) return;

        function setView(view) {
            contactCardView = view;
            toggle.classList.toggle("view-toggle--list", view === "list");
            gridBtn.classList.toggle("active", view === "grid");
            listBtn.classList.toggle("active", view === "list");
            gridBtn.setAttribute("aria-pressed", String(view === "grid"));
            listBtn.setAttribute("aria-pressed", String(view === "list"));
            renderContactQuickCards();
        }

        gridBtn.addEventListener("click", () => setView("grid"));
        listBtn.addEventListener("click", () => setView("list"));
    }

    /* ---------- wiring ---------- */

    function wireStaticControls() {
        document.getElementById("heroAddContactBtn")?.addEventListener("click", () => openContactModal(null, null));
        document.getElementById("addContactBtn")?.addEventListener("click", () => openContactModal(null, null));
        document.getElementById("viewAllContactsBtn")?.addEventListener("click", () => switchTab("contacts"));
        document.getElementById("addOrganizationBtn")?.addEventListener("click", () => openOrganizationModal(null));
        document.getElementById("addUtilityAccountBtn")?.addEventListener("click", () => openUtilityAccountModal(null));
        document.getElementById("addGovOfficeBtn")?.addEventListener("click", () => openGovOfficeModal(null));

        document.getElementById("contactForm")?.addEventListener("submit", submitContactForm);
        document.getElementById("cancelContactBtn")?.addEventListener("click", closeContactModal);
        document.getElementById("contactModalOverlay")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeContactModal(); });

        document.getElementById("organizationForm")?.addEventListener("submit", submitOrganizationForm);
        document.getElementById("cancelOrganizationBtn")?.addEventListener("click", closeOrganizationModal);
        document.getElementById("organizationModalOverlay")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeOrganizationModal(); });

        document.getElementById("utilityAccountForm")?.addEventListener("submit", submitUtilityAccountForm);
        document.getElementById("cancelUtilityAccountBtn")?.addEventListener("click", closeUtilityAccountModal);
        document.getElementById("utilityAccountModalOverlay")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeUtilityAccountModal(); });

        document.getElementById("govOfficeForm")?.addEventListener("submit", submitGovOfficeForm);
        document.getElementById("cancelGovOfficeBtn")?.addEventListener("click", closeGovOfficeModal);
        document.getElementById("govOfficeModalOverlay")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeGovOfficeModal(); });

        document.getElementById("cancelDeleteRecordBtn")?.addEventListener("click", closeDeleteRecordConfirm);
        document.getElementById("confirmDeleteRecordBtn")?.addEventListener("click", confirmDeleteRecord);
        document.getElementById("deleteRecordConfirmOverlay")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeDeleteRecordConfirm(); });
        document.getElementById("deleteRecordConfirmNameInput")?.addEventListener("input", updateDeleteRecordConfirmBtnState);
        document.getElementById("deleteRecordConfirmUnderstandCheckbox")?.addEventListener("change", updateDeleteRecordConfirmBtnState);

        ["contactCardSearchInput", "contactCardTypeFilter", "contactCardSort"].forEach(id => {
            document.getElementById(id)?.addEventListener("input", renderContactQuickCards);
            document.getElementById(id)?.addEventListener("change", renderContactQuickCards);
        });
        ["allContactsSearchInput", "allContactsTypeFilter", "allContactsSort"].forEach(id => {
            document.getElementById(id)?.addEventListener("input", renderAllContactsList);
            document.getElementById(id)?.addEventListener("change", renderAllContactsList);
        });
        ["organizationsSearchInput", "organizationsTypeFilter"].forEach(id => {
            document.getElementById(id)?.addEventListener("input", renderOrganizationsList);
            document.getElementById(id)?.addEventListener("change", renderOrganizationsList);
        });
        ["utilityAccountsSearchInput", "utilityAccountsTypeFilter"].forEach(id => {
            document.getElementById(id)?.addEventListener("input", renderUtilityAccountsList);
            document.getElementById(id)?.addEventListener("change", renderUtilityAccountsList);
        });
        document.getElementById("govOfficesSearchInput")?.addEventListener("input", renderGovOfficesList);

        document.addEventListener("click", handleGlobalClick);

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                closeContactModal();
                closeOrganizationModal();
                closeUtilityAccountModal();
                closeGovOfficeModal();
                closeDeleteRecordConfirm();
                closeAllAccountMenus();
            }
        });
    }

    /* ---------- init ---------- */

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;

        if (error || !project) {
            setAccountsPageMessage("No project selected. Pick one from Project Overview.", "error");
            document.getElementById("accountsLoadingState").style.display = "none";
            return;
        }

        currentProject = project;
        document.getElementById("accountsHeroTitle").textContent = `Accounts / Contacts — ${project.name || "Untitled project"}`;

        initTypeSelects();
        wireTabs();
        wireContactCardViewToggle();
        wireStaticControls();

        await loadMyProjectRole(project.id);
        await loadAllAccountsData(project.id);

        renderProjectDetailsGrid(project);
        renderStatusCard(project);
        renderAll();

        document.getElementById("accountsLoadingState").style.display = "none";
        document.getElementById("accountsBody").style.display = "block";
    });

})();
