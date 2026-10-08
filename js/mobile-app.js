/* ===========================
   MOBILE APP BAR (phones only)

   Adds an app-style bottom tab bar on phone-width screens (styles.css
   hides it above 768px, so desktop and tablets never see it). Loaded on
   every page that has the sidebar, right after script.js.

   The tabs are built FROM the sidebar's own links rather than hardcoded
   URLs, so:
     - a tab only shows if its sidebar link exists and isn't hidden by
       nav-access.js / permissions (same visibility rules, no duplication)
     - project pages keep their ?id=... automatically, because
       project-shell.js has already rewritten those sidebar hrefs
   "More" opens the existing sidebar drawer via #menuBtn (script.js), so
   everything not on the bar is still one tap away.
=========================== */
(function () {
    "use strict";

    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    const isProjectPage = Boolean(document.getElementById("projectSwitcher"));

    // Order = order on the bar. Up to 4 tabs + More. The `fallback` ones
    // only show if one of the main ones is hidden for this person.
    const COMPANY_TABS = [
        { page: "dashboard.html", label: "Home" },
        { page: "project-home.html", label: "Projects" },
        { page: "timesheet.html", label: "Time" },
        { page: "incident-report.html", label: "Report" },
        { page: "vendors.html", label: "Vendors", fallback: true },
        { page: "account-activity.html", label: "Activity", fallback: true },
    ];

    const PROJECT_TABS = [
        { page: "projects.html", label: "Overview" },
        { page: "project-files.html", label: "Files" },
        { page: "project-form-logs.html", label: "Logs" },
        { page: "project-todo.html", label: "To-Do" },
        { page: "project-accounts.html", label: "Contacts", fallback: true },
    ];

    const MAX_TABS = 4;

    function baseName(path) {
        return String(path || "").split("?")[0].split("#")[0].split("/").pop().replace(/\.html$/i, "");
    }

    const currentPage = baseName(window.location.pathname) || "index";

    // Every top-level sidebar link, keyed by page basename.
    function findSidebarLink(page) {
        const want = baseName(page);
        return [...sidebar.querySelectorAll("a.nav-item")].find(a => {
            if (a.classList.contains("nav-parent")) return false;
            const target = a.dataset.navPage || a.getAttribute("href") || "";
            return baseName(target) === want;
        }) || null;
    }

    // nav-access.js hides links with display:none on the link or a parent
    // group; walk up to the sidebar checking for that.
    function isLinkVisible(link) {
        for (let el = link; el && el !== sidebar; el = el.parentElement) {
            if (el.hidden || getComputedStyle(el).display === "none") return false;
        }
        return true;
    }

    const bar = document.createElement("nav");
    bar.className = "mobile-tabbar";
    bar.setAttribute("aria-label", "Main");
    document.body.appendChild(bar);
    document.body.classList.add("has-mobile-tabbar");

    function render() {
        const defs = isProjectPage ? PROJECT_TABS : COMPANY_TABS;
        const picked = [];

        // Fallback tabs are listed last, so they only ever fill slots a
        // hidden main tab left empty.
        for (const def of defs) {
            if (picked.length >= MAX_TABS) break;
            const link = findSidebarLink(def.page);
            if (!link || !isLinkVisible(link)) continue;
            picked.push({ def, link });
        }
        const tabs = picked;

        const html = tabs.map(({ def, link }) => {
            const iconEl = link.querySelector('span[class$="-nav-icon"], span[class*="-nav-icon "]');
            const iconClass = iconEl ? iconEl.className : "docs-nav-icon";
            const active = baseName(def.page) === currentPage;
            // href read live from the sidebar link (project pages rewrite it).
            return `<a class="mobile-tab${active ? " is-active" : ""}" href="${link.getAttribute("href") || "#"}"${active ? ' aria-current="page"' : ""}>
                <span class="mobile-tab-icon ${iconClass}" aria-hidden="true"></span>
                <span class="mobile-tab-label">${def.label}</span>
            </a>`;
        }).join("");

        bar.innerHTML = html + `
            <button type="button" class="mobile-tab mobile-tab--more" aria-label="More pages">
                <span class="mobile-tab-icon mobile-tab-icon--more" aria-hidden="true"></span>
                <span class="mobile-tab-label">More</span>
            </button>`;

        bar.querySelector(".mobile-tab--more").addEventListener("click", () => {
            document.getElementById("menuBtn")?.click();
        });
    }

    // Re-render when the sidebar changes (nav-access.js hiding items after
    // permissions load, project-shell.js filling in ?id= hrefs). Debounced so
    // a burst of changes only rebuilds once.
    let pending = null;
    const observer = new MutationObserver(() => {
        clearTimeout(pending);
        pending = setTimeout(render, 60);
    });
    observer.observe(sidebar, { subtree: true, attributes: true, attributeFilter: ["style", "class", "href", "hidden"] });

    render();
})();
