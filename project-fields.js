/* ===========================================================
   PROJECT FIELDS (shared)
   Single source of truth for every field collected by the New Project
   Onboard wizard (project-home.html / projects-page.js) AND for the
   per-project dashboard pages (projects.html and friends), which use the
   same list to render the Overview summary, the Site Plans page, and the
   sidebar "search everything in this project" feature.

   `page` says which project-dashboard page is the best place to land on
   when a search result for that section is clicked — everything defaults
   to the Overview page except the two document-heavy sections, which have
   their own tab.
=========================================================== */

window.ProjectFields = (function () {

    const PROJECTS_TABLE = "projects";
    // Reads go through this view instead of the base table — it masks the
    // money-adjacent columns (contract_value, utility/trash/porta-potty
    // account numbers) per-row based on the signed-in user's project role,
    // via has_financial_access() (see supabase-rls-lockdown.sql). Writes
    // still go straight to PROJECTS_TABLE, unchanged.
    const PROJECTS_READ_VIEW = "projects_overview";
    const PROJECT_DOCS_BUCKET = "project-documents";

    const WIZARD_STATUS_OPTIONS = ["Not started", "In progress", "Submitted", "Approved"];

    // Canonical project status list — single source of truth for the
    // onboarding wizard's "Status & Tracking" step, the quick-edit popup,
    // the stats header, tabs, and status badges on project-home.html.
    const PROJECT_STATUSES = [
        { value: "active", label: "Active", chip: "chip--success" },
        { value: "onboarding", label: "Onboarding", chip: "chip--info" },
        { value: "on_hold", label: "On Hold", chip: "chip--muted" },
        { value: "completed", label: "Completed", chip: "chip--completed" },
        { value: "archived", label: "Archived", chip: "chip--muted" }
    ];

    const WIZARD_STEPS = [
        {
            key: "owner_contact",
            title: "Property Owner Contact Info",
            hint: "Who owns the property this job is on?",
            page: "projects.html",
            fields: [
                { name: "owner_name", label: "Owner name", type: "text", placeholder: "e.g. Jane Smith" },
                { name: "owner_phone", label: "Phone", type: "tel", placeholder: "e.g. (910) 555-0132" },
                { name: "owner_email", label: "Email", type: "email", placeholder: "e.g. jane@email.com" },
                { name: "owner_address", label: "Mailing address", type: "text", placeholder: "Start typing an address…", addressLookup: true }
            ]
        },
        {
            key: "job_name",
            title: "Job Name",
            hint: "This becomes the project's display name across the portal.",
            page: "projects.html",
            fields: [
                { name: "name", label: "Project / job name", type: "text", placeholder: "e.g. Wilmington Riverfront Renovation" }
            ]
        },
        {
            key: "site_address",
            title: "Job Site Address",
            hint: "Where the work is actually happening.",
            page: "projects.html",
            fields: [
                { name: "site_address", label: "Street address", type: "text", placeholder: "e.g. 123 Main St" },
                { name: "site_city", label: "City", type: "text" },
                { name: "site_state", label: "State", type: "text", maxlength: 2, uppercase: true, placeholder: "e.g. NC" },
                { name: "site_zip", label: "Zip", type: "text" }
            ]
        },
        {
            key: "gc",
            title: "General Contractor",
            hint: "Who's the GC of record for this job?",
            page: "projects.html",
            fields: [
                { name: "gc_name", label: "General contractor name", type: "text" },
                { name: "gc_phone", label: "Phone", type: "tel" },
                { name: "gc_email", label: "Email", type: "email" }
            ]
        },
        {
            key: "poc",
            title: "Project Point of Contact",
            hint: "Who should staff reach out to with questions about this project?",
            page: "projects.html",
            fields: [
                { name: "poc_name", label: "Name", type: "text" },
                { name: "poc_role", label: "Role", type: "text", placeholder: "e.g. Project Manager" },
                { name: "poc_phone", label: "Phone", type: "tel" },
                { name: "poc_email", label: "Email", type: "email" }
            ]
        },
        {
            key: "site_plans",
            title: "Site Plans",
            hint: "Upload the site plan file if you have it, or just note where things stand.",
            page: "project-site-plans.html",
            fields: [
                { name: "site_plans_status", label: "Status", type: "select", options: WIZARD_STATUS_OPTIONS },
                { name: "site_plans_notes", label: "Notes", type: "textarea" },
                { name: "site_plans_file", label: "Site plan file", type: "file", pathField: "site_plans_file_path", accept: ".pdf,.jpg,.jpeg,.png,.dwg" }
            ]
        },
        {
            key: "permit_plans",
            title: "Permit Plans",
            hint: "Upload the permit plan file if you have it, or just note where things stand.",
            page: "project-site-plans.html",
            fields: [
                { name: "permit_number", label: "Permit number", type: "text" },
                { name: "permit_plans_status", label: "Status", type: "select", options: WIZARD_STATUS_OPTIONS },
                { name: "permit_plans_notes", label: "Notes", type: "textarea" },
                { name: "permit_plans_file", label: "Permit plan file", type: "file", pathField: "permit_plans_file_path", accept: ".pdf,.jpg,.jpeg,.png,.dwg" }
            ]
        },
        {
            key: "utilities",
            title: "Utilities Account Info",
            hint: "",
            page: "projects.html",
            fields: [
                { name: "electric_provider", label: "Electric provider", type: "text" },
                { name: "electric_account_number", label: "Electric account #", type: "text" },
                { name: "water_provider", label: "Water provider", type: "text" },
                { name: "water_account_number", label: "Water account #", type: "text" },
                { name: "other_utilities_notes", label: "Other utilities notes", type: "textarea" }
            ]
        },
        {
            key: "temp_services",
            title: "Temporary Trash / Porta Potties",
            hint: "",
            page: "projects.html",
            fields: [
                { name: "trash_vendor", label: "Trash vendor", type: "text" },
                { name: "trash_account_number", label: "Trash account #", type: "text" },
                { name: "porta_potty_vendor", label: "Porta potty vendor", type: "text" },
                { name: "porta_potty_account_number", label: "Porta potty account #", type: "text" },
                { name: "temp_services_notes", label: "Notes", type: "textarea" }
            ]
        },
        {
            key: "county_city",
            title: "County / City Office Contact",
            hint: "Who do we call for permitting or inspections?",
            page: "projects.html",
            fields: [
                { name: "county_city_office_name", label: "Office name", type: "text", placeholder: "e.g. New Hanover County Building Safety" },
                { name: "county_city_contact_name", label: "Contact name", type: "text" },
                { name: "county_city_phone", label: "Phone", type: "tel" },
                { name: "county_city_email", label: "Email", type: "email" }
            ]
        },
        {
            key: "tracking",
            title: "Status & Tracking",
            hint: "Powers the Project Overview cards — the cover photo, status badge, value, progress bar, and due date. Update anytime by reopening this wizard or clicking a card's status badge.",
            page: "projects.html",
            fields: [
                { name: "cover_photo", label: "Cover photo", type: "file", pathField: "cover_photo_url", accept: "image/*", bucket: "project-covers", publicBucket: true },
                { name: "status", label: "Status", type: "select", options: PROJECT_STATUSES, noBlankOption: true, default: "onboarding" },
                { name: "project_manager_name", label: "Project manager", type: "text", placeholder: "e.g. John Smith" },
                { name: "contract_value", label: "Contract value ($)", type: "number", placeholder: "e.g. 4200000", default: null },
                { name: "progress_percent", label: "Progress (%)", type: "number", placeholder: "0–100", default: 0 },
                { name: "due_date", label: "Due date", type: "date" }
            ]
        }
    ];

    function isBlank(value) {
        return value === null || value === undefined || String(value).trim() === "";
    }

    // How many of the wizard's sections have at least one field filled in.
    function computeCompleteness(project) {
        let complete = 0;
        WIZARD_STEPS.forEach(step => {
            const hasValue = step.fields.some(field => {
                const key = field.type === "file" ? field.pathField : field.name;
                return !isBlank(project[key]);
            });
            if (hasValue) complete++;
        });
        return { complete, total: WIZARD_STEPS.length };
    }

    return {
        PROJECTS_TABLE,
        PROJECTS_READ_VIEW,
        PROJECT_DOCS_BUCKET,
        WIZARD_STATUS_OPTIONS,
        PROJECT_STATUSES,
        WIZARD_STEPS,
        isBlank,
        computeCompleteness
    };

})();
