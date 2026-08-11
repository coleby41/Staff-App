const menuBtn = document.getElementById('menuBtn');
const sidebar = document.getElementById('sidebar');
const mainContent = document.querySelector('.main-content');

// Keep this in sync with the "@media (max-width: 820px)" breakpoint in
// styles.css where the sidebar switches to an overlay drawer — mismatched
// breakpoints here is what made the sidebar look broken/unscalable between
// ~768px and ~820px (CSS and JS disagreed on when "mobile" started).
const SIDEBAR_MOBILE_BREAKPOINT = 820;

function isMobileNav() {
    return window.innerWidth <= SIDEBAR_MOBILE_BREAKPOINT;
}

/* On mobile the sidebar becomes a temporary overlay drawer rather than
   permanently-docked chrome, so it needs a dimmed scrim behind it (so the
   page underneath reads as "inactive") and a way to dismiss it by tapping
   outside or pressing Escape — without this, opening the drawer stranded a
   mobile user with no obvious way to close it besides re-finding the same
   menu button. This backdrop element is created once and reused; it's only
   ever visible while both isMobileNav() is true and the drawer is open. */
let sidebarBackdrop = null;
function getSidebarBackdrop() {
    if (sidebarBackdrop) return sidebarBackdrop;
    sidebarBackdrop = document.createElement('div');
    sidebarBackdrop.className = 'sidebar-backdrop';
    sidebarBackdrop.setAttribute('aria-hidden', 'true');
    document.body.appendChild(sidebarBackdrop);
    sidebarBackdrop.addEventListener('click', closeMobileSidebar);
    return sidebarBackdrop;
}

function openMobileSidebar() {
    if (!sidebar || !mainContent) return;
    sidebar.classList.remove('hidden');
    mainContent.classList.remove('expanded');
    getSidebarBackdrop().classList.add('visible');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');
}

function closeMobileSidebar() {
    if (!sidebar || !mainContent) return;
    sidebar.classList.add('hidden');
    mainContent.classList.add('expanded');
    if (sidebarBackdrop) sidebarBackdrop.classList.remove('visible');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
}

if (menuBtn && sidebar && mainContent) {
    menuBtn.addEventListener('click', () => {
        if (isMobileNav()) {
            // On mobile, toggle through the backdrop-aware open/close so the
            // scrim always stays in sync with the drawer.
            if (sidebar.classList.contains('hidden')) {
                openMobileSidebar();
            } else {
                closeMobileSidebar();
            }
        } else {
            sidebar.classList.toggle('hidden');
            mainContent.classList.toggle('expanded');
        }
    });
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isMobileNav() && sidebar && !sidebar.classList.contains('hidden')) {
        closeMobileSidebar();
    }
});

function handleResize() {
    if (!sidebar || !mainContent) return;

    if (isMobileNav()) {
        sidebar.classList.add('hidden');
        mainContent.classList.add('expanded');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('visible');
    } else {
        sidebar.classList.remove('hidden');
        mainContent.classList.remove('expanded');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('visible');
    }
}

window.addEventListener('resize', handleResize);
handleResize();

if (typeof IntersectionObserver !== 'undefined') {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);

    document.querySelectorAll('.card').forEach(card => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        observer.observe(card);
    });
}

function formatDate(dateString) {
    const options = { month: 'short', day: 'numeric', year: 'numeric' };
    return new Date(dateString).toLocaleDateString('en-US', options);
}

function toggleSubnav(event, el) {
    event.preventDefault();
    el.classList.toggle('expanded');
    el.nextElementSibling.classList.toggle('expanded');
}

const notificationBell = document.getElementById("notificationBell");
const notificationDropdown = document.getElementById("notificationDropdown");

notificationBell.addEventListener("click", function () {
    notificationDropdown.classList.toggle("active");
});

// Close when clicking outside
document.addEventListener("click", function(event) {
    if (!event.target.closest(".notification-wrapper")) {
        notificationDropdown.classList.remove("active");
    }
});

/* ===========================
   POPUP SCROLL LOCK (global safety net)
   Most popups already add/remove body.popup-active themselves when they
   open/close, but a few (e.g. the vendor page's report wizard) never did,
   which let the page scroll behind the popup. Instead of patching every
   open/close call site one by one, watch every .popup-overlay element for
   visibility changes and keep body.popup-active in sync automatically.
   This covers every popup on the page today and any added later, even if
   whoever adds them forgets to wire the class manually.
=========================== */
(function () {
    function isOverlayVisible(el) {
        if (el.classList.contains("hidden")) return false;
        return window.getComputedStyle(el).display !== "none";
    }

    function syncPopupActive() {
        const anyVisible = Array.prototype.some.call(
            document.querySelectorAll(".popup-overlay"),
            isOverlayVisible
        );
        document.body.classList.toggle("popup-active", anyVisible);
    }

    const popupObserver = new MutationObserver(syncPopupActive);

    function start() {
        popupObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ["class", "style"],
            subtree: true
        });
        syncPopupActive();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();