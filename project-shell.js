/* ===========================================================
   PROJECT DASHBOARD SHELL (shared by projects.html, project-files.html,
   project-timeline.html, project-todo.html, project-accounting.html,
   project-site-plans.html, project-contract.html)

   Handles everything these pages have in common:
     - reads ?id= from the URL and loads that project from public.projects
     - fills in the header project name, breadcrumb, and document title
     - rewrites every sidebar nav link (anything with [data-nav-page]) to
       carry the current project id, and marks the current page's own
       nav item active
     - populates the project-switcher dropdown with every other project
     - wires the sidebar "search everything in this project" box, which
       searches the CURRENT project's own field values (via
       window.ProjectFields) and links each result to wherever that
       field actually lives

   Each page's own inline script listens for the "project-shell:ready"
   event (detail: { project, error }) to render its own main content —
   this file only owns the chrome (header + sidebar), not the page body.

   Requires project-fields.js to be loaded first.
=========================================================== */

(function () {
    "use strict";

    const PF = window.ProjectFields;

    function escapeHtmlShell(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function currentFileName() {
        return decodeURIComponent(window.location.pathname.split("/").pop() || "");
    }

    function getProjectIdFromUrl() {
        return new URLSearchParams(window.location.search).get("id");
    }

    function buildPageUrl(fileName, projectId, hash) {
        const params = projectId ? `?id=${encodeURIComponent(projectId)}` : "";
        return `${fileName}${params}${hash ? `#${hash}` : ""}`;
    }

    /* ===========================
       NAV LINKS — carry the id, mark the active tab
    =========================== */

    function wireNavLinks(projectId) {
        document.querySelectorAll(".sidebar-nav a[data-nav-page]").forEach(link => {
            const page = link.dataset.navPage;
            link.href = buildPageUrl(page, projectId);
            link.classList.toggle("active", page === currentFileName());
        });
    }

    /* ===========================
       HEADER — project name, breadcrumb, title
    =========================== */

    function renderHeaderForProject(project) {
        const nameEl = document.getElementById("headerProjectName");
        const crumbEl = document.getElementById("headerProjectBreadcrumb");
        const pageNameEl = document.getElementById("headerPageName");
        const pageName = pageNameEl ? pageNameEl.textContent.trim() : "";

        if (nameEl) nameEl.textContent = project ? (project.name || "Untitled project") : "Select a project";
        if (crumbEl) {
            crumbEl.innerHTML = `<a href="project-home.html">Home</a> → ${escapeHtmlShell(project ? (project.name || "Untitled project") : "No project selected")}`;
        }

        document.title = project
            ? `${project.name || "Untitled project"} — ${pageName} | The Leeward Group`
            : `Project Dashboard | The Leeward Group`;
    }

    function renderHeaderError() {
        const nameEl = document.getElementById("headerProjectName");
        const crumbEl = document.getElementById("headerProjectBreadcrumb");
        if (nameEl) nameEl.textContent = "No project selected";
        if (crumbEl) crumbEl.innerHTML = `<a href="project-home.html">Home</a> → Pick a project from Project Overview`;
    }

    /* ===========================
       PROJECT SWITCHER DROPDOWN
    =========================== */

    function wireSwitcherToggle() {
        const switcher = document.getElementById("projectSwitcher");
        const toggle = document.getElementById("projectSwitcherToggle");
        const dropdown = document.getElementById("projectSwitcherDropdown");
        if (!switcher || !toggle || !dropdown) return;

        toggle.addEventListener("click", (event) => {
            event.stopPropagation();
            const isOpen = !dropdown.classList.contains("hidden");
            dropdown.classList.toggle("hidden", isOpen);
            switcher.classList.toggle("is-open", !isOpen);
        });

        document.addEventListener("click", (event) => {
            if (!switcher.contains(event.target)) {
                dropdown.classList.add("hidden");
                switcher.classList.remove("is-open");
            }
        });
    }

    async function populateSwitcher(currentProjectId) {
        const dropdown = document.getElementById("projectSwitcherDropdown");
        if (!dropdown || !window.supabaseClient) return;

        const { data, error } = await window.supabaseClient
            .from(PF.PROJECTS_TABLE)
            .select("id, name")
            .order("name", { ascending: true });

        if (error) {
            dropdown.innerHTML = `<p class="project-switcher-empty">Couldn't load other projects.</p>`;
            return;
        }

        if (!data || data.length === 0) {
            dropdown.innerHTML = `<p class="project-switcher-empty">No projects yet.</p>`;
            return;
        }

        dropdown.innerHTML = data.map(p => `
            <button
                type="button"
                class="project-switcher-option ${String(p.id) === String(currentProjectId) ? "is-current" : ""}"
                data-project-id="${p.id}">
                ${escapeHtmlShell(p.name || "Untitled project")}
            </button>
        `).join("");

        dropdown.querySelectorAll(".project-switcher-option").forEach(btn => {
            btn.addEventListener("click", () => {
                window.location.href = buildPageUrl(currentFileName(), btn.dataset.projectId);
            });
        });
    }

    /* ===========================
       SIDEBAR SEARCH — "everything in this project"
       Searches the current project's own field values today. As Project
       Files / Timeline / To-Do / Accounting / Contract get real content,
       add their data sources here too.
    =========================== */

    function searchProjectFields(project, query) {
        const q = query.trim().toLowerCase();
        if (!q) return [];

        const results = [];
        PF.WIZARD_STEPS.forEach(step => {
            step.fields.forEach(field => {
                const key = field.type === "file" ? field.pathField : field.name;
                const raw = project[key];
                if (PF.isBlank(raw)) return;

                const value = String(raw);
                const haystack = `${field.label} ${value}`.toLowerCase();
                if (!haystack.includes(q)) return;

                results.push({
                    sectionTitle: step.title,
                    label: field.label,
                    value: field.type === "file" ? value.split("/").pop() : value,
                    page: step.page,
                    anchor: `field-${field.name}`
                });
            });
        });

        return results.slice(0, 8);
    }

    function wireSidebarSearch(project) {
        const input = document.getElementById("sidebarSearchInput");
        const resultsEl = document.getElementById("sidebarSearchResults");
        const hintEl = document.getElementById("sidebarSearchShortcutHint");
        if (!input || !resultsEl) return;

        function updateHintVisibility() {
            if (hintEl) hintEl.classList.toggle("is-hidden", input.value.trim().length > 0);
        }
        input.addEventListener("input", updateHintVisibility);

        function renderResults() {
            const query = input.value;

            if (!query.trim()) {
                resultsEl.classList.add("hidden");
                resultsEl.innerHTML = "";
                return;
            }

            if (!project) {
                resultsEl.classList.remove("hidden");
                resultsEl.innerHTML = `<p class="sidebar-search-empty">Select a project first.</p>`;
                return;
            }

            const results = searchProjectFields(project, query);

            resultsEl.classList.remove("hidden");
            resultsEl.innerHTML = results.length
                ? results.map(r => `
                    <a class="sidebar-search-result" href="${buildPageUrl(r.page, project.id, r.anchor)}">
                        <span class="sidebar-search-result-label">${escapeHtmlShell(r.sectionTitle)} · ${escapeHtmlShell(r.label)}</span>
                        <span class="sidebar-search-result-value">${escapeHtmlShell(r.value)}</span>
                    </a>
                `).join("")
                : `<p class="sidebar-search-empty">No matches in this project's details yet. Project Files / Timeline / To-Do / Accounting / Contract search is coming as those areas get built out.</p>`;
        }

        input.addEventListener("input", renderResults);
        input.addEventListener("focus", renderResults);

        document.addEventListener("click", (event) => {
            if (!event.target.closest(".sidebar-search-wrap")) {
                resultsEl.classList.add("hidden");
            }
        });
    }

    // If we arrived via a #field-xxx link, scroll to it and briefly
    // highlight it once the page's own content has rendered.
    function highlightHashTarget() {
        const hash = window.location.hash.replace("#", "");
        if (!hash) return;
        // Give the page's own render listener a tick to build the DOM.
        setTimeout(() => {
            const el = document.getElementById(hash);
            if (!el) return;
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("is-highlighted");
            setTimeout(() => el.classList.remove("is-highlighted"), 2500);
        }, 150);
    }

    /* ===========================
       ⌘F / CTRL+F -> SIDEBAR SEARCH
       Intercepts the browser's native "Find in page" shortcut and
       redirects it to the sidebar search box instead (Vercel-style
       command bar behavior). Wired at document level so it works
       regardless of what's currently focused on the page.
    =========================== */

    function initSearchShortcut() {
        document.addEventListener("keydown", (event) => {
            const key = event.key ? event.key.toLowerCase() : "";
            const isFindShortcut = (event.metaKey || event.ctrlKey) && key === "f";
            if (!isFindShortcut) return;

            const input = document.getElementById("sidebarSearchInput");
            if (!input) return;

            event.preventDefault();

            // If the sidebar is collapsed to icon-only, expand it first —
            // the search box is hidden in that state.
            if (document.body.classList.contains("sidebar-collapsed")) {
                document.body.classList.remove("sidebar-collapsed");
                const collapseToggle = document.getElementById("sidebarCollapseToggle");
                if (collapseToggle) {
                    collapseToggle.classList.remove("is-collapsed");
                    collapseToggle.setAttribute("aria-label", "Collapse navigation");
                }
            }

            input.focus();
            input.select();
        });
    }

    /* ===========================
       SIDEBAR COLLAPSE TOGGLE
       A small round tab straddling the sidebar's right edge, vertically
       centered on the first nav item (Overview) — replaces the old
       hamburger menu on this page family. Collapses to an icon-only rail
       rather than hiding the sidebar entirely. Positioned via JS (not
       just CSS) so it tracks the sidebar's real edge through the width
       transition and any responsive breakpoint changes.
    =========================== */

    function initSidebarCollapse() {
        const sidebar = document.getElementById("sidebar");
        if (!sidebar || document.getElementById("sidebarCollapseToggle")) return;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.id = "sidebarCollapseToggle";
        toggle.className = "sidebar-collapse-toggle";
        toggle.setAttribute("aria-label", "Collapse navigation");
        toggle.innerHTML = `<span class="sidebar-collapse-toggle-icon">&lsaquo;</span>`;
        document.body.appendChild(toggle);

        function positionToggle() {
            const firstItem = sidebar.querySelector(".sidebar-nav .nav-item");
            const sidebarRect = sidebar.getBoundingClientRect();
            const anchorRect = (firstItem || sidebar).getBoundingClientRect();
            toggle.style.left = `${sidebarRect.right}px`;
            toggle.style.top = `${anchorRect.top + anchorRect.height / 2}px`;
        }

        // The arrow itself never changes character — it just rotates 180°
        // via CSS, which reads as a smooth flip rather than a hard swap.
        function setCollapsed(collapsed) {
            document.body.classList.toggle("sidebar-collapsed", collapsed);
            toggle.classList.toggle("is-collapsed", collapsed);
            toggle.setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
        }

        toggle.addEventListener("click", () => {
            setCollapsed(!document.body.classList.contains("sidebar-collapsed"));
            positionToggle();
        });

        // Sidebar width animates (see .sidebar's transition) — reposition
        // once mid-flight and once after it settles so the tab doesn't lag.
        sidebar.addEventListener("transitionend", (event) => {
            if (event.propertyName === "width") positionToggle();
        });
        window.addEventListener("resize", positionToggle);

        positionToggle();
    }

    /* ===========================
       INIT
    =========================== */

    async function initProjectShell() {
        if (!window.supabaseClient) {
            setTimeout(initProjectShell, 150);
            return;
        }

        const projectId = getProjectIdFromUrl();
        wireNavLinks(projectId);
        wireSwitcherToggle();

        if (!projectId) {
            renderHeaderError();
            wireSidebarSearch(null);
            window.dispatchEvent(new CustomEvent("project-shell:ready", { detail: { project: null, error: null } }));
            return;
        }

        const { data, error } = await window.supabaseClient
            .from(PF.PROJECTS_TABLE)
            .select("*")
            .eq("id", projectId)
            .maybeSingle();

        if (error || !data) {
            renderHeaderError();
            wireSidebarSearch(null);
            window.dispatchEvent(new CustomEvent("project-shell:ready", { detail: { project: null, error: error || new Error("Project not found") } }));
            return;
        }

        renderHeaderForProject(data);
        wireSidebarSearch(data);
        populateSwitcher(projectId);

        window.dispatchEvent(new CustomEvent("project-shell:ready", { detail: { project: data, error: null } }));

        highlightHashTarget();
    }

    document.addEventListener("DOMContentLoaded", () => {
        initSidebarCollapse();
        initSearchShortcut();
        initProjectShell();
    });

})();
