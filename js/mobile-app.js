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
   "More" opens a bottom sheet (see MORE SHEET below) listing every other
   page this person can see, again read live from the sidebar.
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

    let tabPages = new Set();

    // Is the current page one of the sidebar's links, i.e. a page the More
    // sheet covers? Covers grouped links (Company docs, IT Tools) too.
    // Deliberately ignores visibility: if you're ON the page, it counts,
    // even while a permission script still has its link hidden.
    function isInMoreSheet() {
        return [...sidebar.querySelectorAll("a.nav-item:not(.nav-parent), a.subnav-item")].some(a =>
            baseName(a.dataset.navPage || a.getAttribute("href")) === currentPage);
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
        tabPages = new Set(tabs.map(t => baseName(t.def.page)));

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

        // On a page that's reached through the More sheet (not on the bar),
        // More gets the active bubble instead of nothing being highlighted.
        const onTabPage = tabs.some(({ def }) => baseName(def.page) === currentPage);
        const moreActive = !onTabPage && isInMoreSheet();

        bar.innerHTML = html + `
            <button type="button" class="mobile-tab mobile-tab--more${moreActive ? " is-active" : ""}" aria-label="More pages"${moreActive ? ' aria-current="page"' : ""}>
                <span class="mobile-tab-icon mobile-tab-icon--more" aria-hidden="true"></span>
                <span class="mobile-tab-label">More</span>
            </button>`;

        bar.querySelector(".mobile-tab--more").addEventListener("click", openSheet);
    }

    /* ===========================
       MORE SHEET
       Slides up from the bottom over a blurred (not darkened) page.
       - Company pages: who you are, then every visible sidebar page that
         isn't already on the tab bar as a list, grouped the same way the
         sidebar groups them (Company docs, IT Tools...), then Change
         Password / Sign out.
       - Project pages: the current project with a Switch button, the
         project pages not on the tab bar as a list, then links back out to
         the company side.
       Built fresh on every open, so it always matches what nav-access.js
       currently shows and the current ?id= hrefs.
       Closes on: ✕, tapping the blurred area, Escape, swiping it down.
    =========================== */

    function esc(str) {
        return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function linkLabel(link) {
        return (link.querySelector(".nav-text")?.textContent || link.textContent || "").replace(/\s+/g, " ").trim();
    }

    function linkIconClass(link, fallbackLink) {
        const icon = link.querySelector('span[class$="-nav-icon"], span[class*="-nav-icon "]')
            || fallbackLink?.querySelector('span[class$="-nav-icon"], span[class*="-nav-icon "]');
        return icon ? icon.className : "docs-nav-icon";
    }

    function linkBadge(link) {
        const badge = link.querySelector(".nav-item-badge");
        if (!badge || getComputedStyle(badge).display === "none") return "";
        const n = badge.textContent.trim();
        return n ? `<span class="mobile-sheet-badge">${esc(n)}</span>` : "";
    }

    function linkTarget(link) {
        return link.getAttribute("target") === "_blank" ? ' target="_blank" rel="noopener"' : "";
    }

    function getProfile() {
        if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
        try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; }
    }

    const scrim = document.createElement("div");
    scrim.className = "mobile-sheet-scrim";
    scrim.setAttribute("aria-hidden", "true");

    const sheet = document.createElement("section");
    sheet.className = "mobile-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "More pages");
    sheet.setAttribute("aria-hidden", "true");

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    const CLOSE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg>`;
    const CHEVRON = `<svg class="mobile-sheet-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>`;

    const EXTERNAL = `<svg class="mobile-sheet-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M20 4l-9 9"></path><path d="M18 14v6H4V6h6"></path></svg>`;

    // One sidebar link as a list row (icon, label, badge, chevron).
    // Subnav items have no icon of their own, so they borrow their group's.
    function linkRow(link, iconFrom) {
        const href = link.getAttribute("href") || "#";
        const active = baseName(href) === currentPage;
        const external = link.getAttribute("target") === "_blank";
        return `<a class="mobile-sheet-row${active ? " is-active" : ""}" href="${esc(href)}"${linkTarget(link)}>
            <span class="mobile-sheet-row-icon"><span class="${linkIconClass(link, iconFrom)}" aria-hidden="true"></span></span>
            <span class="mobile-sheet-row-label">${esc(linkLabel(link))}</span>
            ${linkBadge(link)}
            ${external ? EXTERNAL : CHEVRON}
        </a>`;
    }

    function row(href, label, iconClass, extra, opts = {}) {
        const active = baseName(href) === currentPage;
        return `<a class="mobile-sheet-row${opts.muted ? " mobile-sheet-row--muted" : ""}${active ? " is-active" : ""}" href="${esc(href)}">
            <span class="mobile-sheet-row-icon"><span class="${iconClass}" aria-hidden="true"></span></span>
            <span class="mobile-sheet-row-label">${esc(label)}</span>
            ${extra || CHEVRON}
        </a>`;
    }

    function buildCompanySheet() {
        const profile = getProfile();
        const name = profile?.full_name || profile?.username || "Signed in";
        const groups = Array.isArray(profile?.workgroup) ? profile.workgroup.join(" · ") : (profile?.workgroup || "");
        const initials = (document.getElementById("brandInitials")?.textContent || name.split(/\s+/).map(w => w[0]).join("").slice(0, 2)).trim();

        // Walk the sidebar in order: loose links collect into "Pages";
        // each collapsible group (Company docs, IT Tools...) is its own section.
        const nav = sidebar.querySelector(".sidebar-nav") || sidebar;
        const sections = [];
        const loose = [];
        for (const el of nav.children) {
            if (el.matches("a.nav-item")) {
                if (!isLinkVisible(el) || tabPages.has(baseName(el.dataset.navPage || el.getAttribute("href")))) continue;
                loose.push(linkRow(el));
            } else if (el.matches(".nav-item-group") && isLinkVisible(el)) {
                const parent = el.querySelector(".nav-parent");
                const items = [...el.querySelectorAll("a.subnav-item")].filter(isLinkVisible).map(a => linkRow(a, parent));
                if (items.length) sections.push({ title: parent ? linkLabel(parent) : "", items });
            }
        }
        if (loose.length) sections.unshift({ title: "Pages", items: loose });

        return `
            <div class="mobile-sheet-handle"><span></span></div>
            <div class="mobile-sheet-head">
                <div class="mobile-sheet-avatar">${esc(initials)}</div>
                <div class="mobile-sheet-who">
                    <div class="mobile-sheet-name">${esc(name)}</div>
                    ${groups ? `<div class="mobile-sheet-sub">${esc(groups)}</div>` : ""}
                </div>
                <button type="button" class="mobile-sheet-close" aria-label="Close menu">${CLOSE_ICON}</button>
            </div>
            <div class="mobile-sheet-body">
                ${sections.map(sec => `
                    ${sec.title ? `<div class="mobile-sheet-section">${esc(sec.title)}</div>` : ""}
                    ${sec.items.join("")}
                `).join("")}
            </div>
            <div class="mobile-sheet-foot">
                <button type="button" class="mobile-sheet-btn" data-action="password">Change Password</button>
                <button type="button" class="mobile-sheet-btn mobile-sheet-btn--danger" data-action="signout">Sign out</button>
            </div>`;
    }

    function buildProjectSheet() {
        const projectName = (document.getElementById("headerProjectName")?.textContent || "Project").trim();
        const nav = sidebar.querySelector(".sidebar-nav") || sidebar;
        const rows = [...nav.querySelectorAll("a.nav-item")]
            .filter(a => isLinkVisible(a) && !tabPages.has(baseName(a.dataset.navPage || a.getAttribute("href"))))
            .map(a => {
                const page = baseName(a.dataset.navPage || a.getAttribute("href"));
                // The schedule is desktop-only on phones (see project-timeline.html).
                const extra = page === "project-timeline" ? `<span class="mobile-sheet-pill">Desktop</span>` : "";
                return row(a.getAttribute("href") || "#", linkLabel(a), linkIconClass(a), extra);
            });

        return `
            <div class="mobile-sheet-handle"><span></span></div>
            <div class="mobile-sheet-head mobile-sheet-head--project">
                <div class="mobile-sheet-project">
                    <span class="mobile-sheet-avatar mobile-sheet-avatar--project"><span class="projects-nav-icon" aria-hidden="true"></span></span>
                    <div class="mobile-sheet-who">
                        <div class="mobile-sheet-sub mobile-sheet-eyebrow">Current project</div>
                        <div class="mobile-sheet-name">${esc(projectName)}</div>
                    </div>
                    <button type="button" class="mobile-sheet-switch" data-action="switch">Switch</button>
                </div>
                <button type="button" class="mobile-sheet-close" aria-label="Close menu">${CLOSE_ICON}</button>
            </div>
            <div class="mobile-sheet-body">
                ${rows.join("")}
                <div class="mobile-sheet-divider"></div>
                ${row("/pages/dashboard.html", "Company Dashboard", "home-nav-icon", "", { muted: true })}
                ${row("/pages/project-home.html", "All Projects", "projects-nav-icon", "", { muted: true })}
            </div>`;
    }

    let lastFocus = null;

    function openSheet() {
        sheet.innerHTML = isProjectPage ? buildProjectSheet() : buildCompanySheet();
        lastFocus = document.activeElement;
        document.getElementById("notificationDropdown")?.classList.remove("active");
        document.body.classList.add("mobile-sheet-open");
        sheet.setAttribute("aria-hidden", "false");
        sheet.style.transform = "";
        sheet.querySelector(".mobile-sheet-close")?.focus({ preventScroll: true });
    }

    function closeSheet() {
        if (!document.body.classList.contains("mobile-sheet-open")) return;
        document.body.classList.remove("mobile-sheet-open");
        sheet.setAttribute("aria-hidden", "true");
        sheet.style.transform = "";
        lastFocus?.focus?.({ preventScroll: true });
    }

    scrim.addEventListener("click", closeSheet);
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

    sheet.addEventListener("click", e => {
        if (e.target.closest(".mobile-sheet-close")) return closeSheet();
        const action = e.target.closest("[data-action]")?.dataset.action;
        if (action === "password") {
            closeSheet();
            if (typeof window.openChangePasswordModal === "function") window.openChangePasswordModal();
            else document.getElementById("changePasswordBtn")?.click();
        } else if (action === "signout") {
            if (typeof window.signOutUser === "function") window.signOutUser();
        } else if (action === "switch") {
            closeSheet();
            // Let this tap finish first, or project-shell.js's "click outside
            // closes it" handler would shut the dropdown right away.
            setTimeout(() => document.getElementById("projectSwitcherToggle")?.click(), 0);
        }
    });

    // Swipe down on the handle/header to dismiss.
    let dragStartY = null;
    sheet.addEventListener("touchstart", e => {
        if (!e.target.closest(".mobile-sheet-handle, .mobile-sheet-head")) return;
        dragStartY = e.touches[0].clientY;
        sheet.classList.add("is-dragging");
    }, { passive: true });
    sheet.addEventListener("touchmove", e => {
        if (dragStartY === null) return;
        const dy = Math.max(0, e.touches[0].clientY - dragStartY);
        sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener("touchend", e => {
        if (dragStartY === null) return;
        const dy = (e.changedTouches[0]?.clientY ?? dragStartY) - dragStartY;
        dragStartY = null;
        sheet.classList.remove("is-dragging");
        if (dy > 90) closeSheet();
        else sheet.style.transform = "";
    });

    // Rotating/resizing up past phone width while it's open: just close it.
    window.addEventListener("resize", () => { if (window.innerWidth > 768) closeSheet(); });

    /* ===========================
       SCROLL LOCK (phones)
       While the More sheet, the notification panel, or any popup is open,
       the page behind must not move. iPhone Safari ignores overflow:hidden
       on <body> for touch scrolling, so the reliable way is to pin <body>
       with position:fixed at the current scroll offset, then put the page
       back exactly where it was on close. Scrolling INSIDE the sheet /
       panel / popup still works (they're their own scroll areas).
    =========================== */
    let lockedScrollY = null;

    function setScrollLocked(locked) {
        const body = document.body;
        if (locked && lockedScrollY === null) {
            lockedScrollY = window.scrollY;
            body.style.position = "fixed";
            body.style.top = `-${lockedScrollY}px`;
            body.style.left = "0";
            body.style.right = "0";
            body.style.width = "100%";
            document.documentElement.classList.add("is-scroll-locked");
        } else if (!locked && lockedScrollY !== null) {
            const y = lockedScrollY;
            lockedScrollY = null;
            body.style.position = "";
            body.style.top = "";
            body.style.left = "";
            body.style.right = "";
            body.style.width = "";
            document.documentElement.classList.remove("is-scroll-locked");
            window.scrollTo(0, y);
        }
    }

    function syncScrollLock() {
        const body = document.body;
        const somethingOpen =
            body.classList.contains("mobile-sheet-open") ||
            body.classList.contains("popup-active") ||
            Boolean(document.querySelector(".notification-dropdown.active"));
        setScrollLocked(somethingOpen && window.innerWidth <= 768);
    }

    const lockObserver = new MutationObserver(syncScrollLock);
    lockObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const notifDropdown = document.getElementById("notificationDropdown");
    if (notifDropdown) lockObserver.observe(notifDropdown, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", syncScrollLock);

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
