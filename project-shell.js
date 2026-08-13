/* ===========================================================
   PROJECT DASHBOARD SHELL (shared by projects.html, project-files.html,
   project-timeline.html, project-to-do.html, project-accounting.html,
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
    const TIMELINE_TABLE = "project_timeline_items";
    const TODO_ITEMS_TABLE = "project_todo_items";
    const TODO_SUBITEMS_TABLE = "project_todo_subitems";

    // Timeline/To-Do data for search, fetched once per project load — see
    // loadSearchData(). The sidebar search box lives on every project-*.html
    // page, not just project-timeline.html/project-to-do.html, so it can't
    // rely on those pages' own scripts to have loaded this data; it fetches
    // its own copy independently. Populated in the background (not awaited
    // before project-shell:ready fires) since it's a nice-to-have, not
    // something the rest of the page should wait on.
    let searchTimelineData = [];
    let searchTodoItemsData = [];
    let searchTodoSubitemsByItemId = {};
    let rerenderSearchResults = null; // set by wireSidebarSearch — lets loadSearchData refresh results already on screen once it resolves

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
       Searches, in order: Project Timeline (phases/tasks/milestones),
       Project To-Do (big items + checklist rows), and the project's own
       field values (site address, dates, budget, etc. — via
       window.ProjectFields). Project Files / Accounting / Site Plans /
       Contract don't have real data models yet — add their sources here
       too once they do.

       "Complex searching": each source builds one lowercase haystack per
       result (title/label + description + type + status + assignee name +
       formatted dates, depending on the source) and the query is split on
       whitespace into terms that ALL have to appear somewhere in that
       haystack, in any order — so "sarah foundation" finds a task titled
       "Pour foundation" assigned to Sarah Diaz, not just a literal
       "sarah foundation" substring.
    =========================== */

    function queryTerms(query) {
        return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    }

    function matchesAllTerms(haystackParts, terms) {
        const haystack = haystackParts.filter(Boolean).join(" ").toLowerCase();
        return terms.every(term => haystack.includes(term));
    }

    function formatSearchDate(iso) {
        if (!iso) return "";
        return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    function searchProjectFields(project, terms) {
        const results = [];
        PF.WIZARD_STEPS.forEach(step => {
            step.fields.forEach(field => {
                const key = field.type === "file" ? field.pathField : field.name;
                const raw = project[key];
                if (PF.isBlank(raw)) return;

                const value = String(raw);
                if (!matchesAllTerms([field.label, value], terms)) return;

                results.push({
                    sectionTitle: step.title,
                    label: field.label,
                    value: field.type === "file" ? value.split("/").pop() : value,
                    page: step.page,
                    anchor: `field-${field.name}`
                });
            });
        });

        return results;
    }

    // typeLabel below is literally "task"/"phase"/"milestone" (whichever
    // this item actually is) and doubles as the search keyword for that
    // type — searching "task" surfaces task-type items specifically, not
    // phases or milestones too, same as searching "milestone" only
    // surfaces milestones.
    const TIMELINE_STATUS_LABEL = { not_started: "not started", in_progress: "in progress", on_hold: "on hold", completed: "completed" };

    function searchTimelineItems(terms) {
        const today = todayISODateShell();
        const results = [];

        searchTimelineData.forEach(item => {
            const isOverdue = item.status !== "completed" && !!item.end_date && item.end_date < today;
            const statusLabel = isOverdue ? "overdue" : (TIMELINE_STATUS_LABEL[item.status] || item.status || "");
            const typeLabel = item.type || "task";
            const dateText = item.type === "milestone"
                ? formatSearchDate(item.end_date)
                : [formatSearchDate(item.start_date), formatSearchDate(item.end_date)].filter(Boolean).join(" – ");

            const haystack = [item.title, item.description, typeLabel, statusLabel, item.assigned_to_name, dateText];
            if (!matchesAllTerms(haystack, terms)) return;

            results.push({
                sectionTitle: "Timeline",
                label: `${typeLabel.charAt(0).toUpperCase()}${typeLabel.slice(1)}${statusLabel ? " · " + statusLabel : ""}`,
                value: item.title || "Untitled",
                page: "project-timeline.html",
                openItem: item.id
            });
        });

        return results;
    }

    function searchTodoItems(terms) {
        const results = [];

        searchTodoItemsData.forEach(item => {
            const itemHaystack = [item.title, "to-do", "task", item.completed ? "complete" : "open"];
            if (matchesAllTerms(itemHaystack, terms)) {
                results.push({
                    sectionTitle: "To-Do",
                    label: item.completed ? "Completed" : "Open",
                    value: item.title || "Untitled",
                    page: "project-to-do.html",
                    openItem: item.id
                });
            }

            (searchTodoSubitemsByItemId[item.id] || []).forEach(sub => {
                const subHaystack = [sub.label, item.title, sub.assigned_to_name, formatSearchDate(sub.due_date), "to-do", "task", "checklist", sub.completed ? "complete" : "open"];
                if (!matchesAllTerms(subHaystack, terms)) return;
                results.push({
                    sectionTitle: "To-Do",
                    label: `${item.title || "Untitled"} · checklist`,
                    value: sub.label || "Untitled",
                    page: "project-to-do.html",
                    openItem: item.id // opens the parent item's panel, where this checklist row lives
                });
            });
        });

        return results;
    }

    function todayISODateShell() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    async function loadSearchData(projectId) {
        if (!window.supabaseClient) return;

        const [timelineResult, todoItemsResult, todoSubitemsResult] = await Promise.all([
            window.supabaseClient
                .from(TIMELINE_TABLE)
                .select("id, type, title, description, status, start_date, end_date, assigned_to_name")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(TODO_ITEMS_TABLE)
                .select("id, title, completed")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(TODO_SUBITEMS_TABLE)
                .select("id, todo_item_id, label, assigned_to_name, due_date, completed")
                .eq("project_id", projectId)
        ]);

        if (!timelineResult.error) searchTimelineData = timelineResult.data || [];
        if (!todoItemsResult.error) searchTodoItemsData = todoItemsResult.data || [];

        searchTodoSubitemsByItemId = {};
        if (!todoSubitemsResult.error) {
            (todoSubitemsResult.data || []).forEach(sub => {
                (searchTodoSubitemsByItemId[sub.todo_item_id] = searchTodoSubitemsByItemId[sub.todo_item_id] || []).push(sub);
            });
        }

        // If the user already typed a query before this resolved, refresh
        // whatever's currently on screen rather than making them retype.
        if (rerenderSearchResults) rerenderSearchResults();
    }

    function buildResultUrl(result, projectId) {
        if (result.openItem) return `${result.page}?id=${encodeURIComponent(projectId)}&openItem=${encodeURIComponent(result.openItem)}`;
        return buildPageUrl(result.page, projectId, result.anchor);
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

            const terms = queryTerms(query);
            const results = [
                ...searchTimelineItems(terms),
                ...searchTodoItems(terms),
                ...searchProjectFields(project, terms)
            ].slice(0, 12);

            resultsEl.classList.remove("hidden");
            resultsEl.innerHTML = results.length
                ? results.map(r => `
                    <a class="sidebar-search-result" href="${buildResultUrl(r, project.id)}">
                        <span class="sidebar-search-result-label">${escapeHtmlShell(r.sectionTitle)} · ${escapeHtmlShell(r.label)}</span>
                        <span class="sidebar-search-result-value">${escapeHtmlShell(r.value)}</span>
                    </a>
                `).join("")
                : `<p class="sidebar-search-empty">No matches for "${escapeHtmlShell(query.trim())}" in this project.</p>`;
        }

        input.addEventListener("input", renderResults);
        input.addEventListener("focus", renderResults);
        rerenderSearchResults = renderResults;

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
        loadSearchData(projectId); // background — not awaited, see loadSearchData's own comment

        window.dispatchEvent(new CustomEvent("project-shell:ready", { detail: { project: data, error: null } }));

        highlightHashTarget();
    }

    document.addEventListener("DOMContentLoaded", () => {
        initSidebarCollapse();
        initSearchShortcut();
        initProjectShell();
    });

})();
