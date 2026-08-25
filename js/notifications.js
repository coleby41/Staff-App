/* ===========================
   NOTIFICATIONS (Supabase) — shared across every page with the bell icon.
   Uses window.supabaseClient, exposed globally by supabase-auth.js.

   This used to be copy-pasted inline into ~8 different pages (dashboard,
   payroll-tools, venders, manage-employees, new-project, excel-workbook,
   form-template, timesheet), plus a couple of pages (my-tasks, projects)
   that had the bell markup but no loading logic wired at all. The
   "Mark as read" button existed on every page but was never actually
   wired to anything anywhere.

   Read state used to live in localStorage (readNotificationIds), which
   meant it didn't follow a person across devices/browsers, and clicking
   the bell just silently marked things read without the button doing
   anything. Both are fixed here:
     - Read state is now tracked server-side in `notification_reads`
       (see supabase-notification-reads-setup.sql), keyed to the signed-in
       staff_users row, so it's consistent everywhere that person signs in.
     - Once something is marked read, it's dropped from `currentNotifications`
       entirely (not just hidden from the badge count) — it won't come back
       on this page or any other until a new notification is created.
=========================== */

let currentNotifications = [];

function notifyEscapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
}

function getNotificationsStaffProfile() {
    if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
    try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); }
    catch { return null; }
}

function getNotificationsStaffId() {
    const profile = getNotificationsStaffProfile();
    return profile?.id || profile?.uid || null;
}

async function loadNotifications() {
    if (!window.supabaseClient) { console.error("Supabase client not ready yet"); return; }

    const userId = getNotificationsStaffId();

    let query = window.supabaseClient
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);

    query = userId
        ? query.or(`user_id.is.null,user_id.eq.${userId}`)
        : query.is("user_id", null);

    const { data, error } = await query;
    if (error) { console.error("Failed to load notifications:", error); return; }

    const all = data || [];

    let readIds = new Set();
    if (userId && all.length) {
        const { data: readRows, error: readError } = await window.supabaseClient
            .from("notification_reads")
            .select("notification_id")
            .eq("staff_user_id", userId)
            .in("notification_id", all.map(n => n.id));

        if (readError) console.error("Failed to load read state:", readError);
        else readIds = new Set((readRows || []).map(r => r.notification_id));
    }

    // Already-read notifications simply don't show up anymore, on any page.
    currentNotifications = all.filter(n => !readIds.has(n.id));
    renderNotifications();
}

function renderNotifications() {
    const list = document.getElementById("notificationList");
    const empty = document.getElementById("notificationEmpty");
    const countEl = document.querySelector(".notification-count");

    if (countEl) {
        if (currentNotifications.length > 0) {
            countEl.style.display = "inline-flex";
            countEl.textContent = currentNotifications.length > 9 ? "9+" : String(currentNotifications.length);
        } else {
            countEl.style.display = "none";
        }
    }

    if (!list) return;
    list.innerHTML = "";

    if (currentNotifications.length === 0) {
        if (empty) empty.style.display = "block";
        return;
    }
    if (empty) empty.style.display = "none";

    currentNotifications.forEach(n => {
        const div = document.createElement("div");
        div.className = "notification-item";
        const linkHtml = n.link_url
            ? `<a class="notification-link" href="${notifyEscapeHtml(n.link_url)}">${notifyEscapeHtml(n.link_label || "View it here")}</a>`
            : "";
        div.innerHTML = `
            <strong>${notifyEscapeHtml(n.title)}</strong>
            <p>${notifyEscapeHtml(n.message)}</p>
            ${linkHtml}
        `;
        list.appendChild(div);
    });
}

// The actual "Mark as read" button in the dropdown header. Marks everything
// currently shown as read for this staff member and removes it from view.
async function markAllNotificationsRead() {
    if (!currentNotifications.length) return;

    const userId = getNotificationsStaffId();
    if (!userId) {
        console.warn("Can't persist read state — no signed-in staff profile yet.");
        return;
    }

    const rows = currentNotifications.map(n => ({
        notification_id: n.id,
        staff_user_id: userId
    }));

    const { error } = await window.supabaseClient
        .from("notification_reads")
        .upsert(rows, { onConflict: "notification_id,staff_user_id", ignoreDuplicates: true });

    if (error) { console.error("Failed to mark notifications read:", error); return; }

    currentNotifications = [];
    renderNotifications();
}

function wireMarkReadButton() {
    const btn = document.querySelector("#notificationDropdown .mark-read-btn");
    if (!btn) return;
    btn.addEventListener("click", function (event) {
        event.preventDefault();
        markAllNotificationsRead();
    });
}

// Refresh whenever the bell is opened, so read state stays current across
// tabs/devices now that it's server-side instead of per-browser localStorage.
// notificationBell is declared with `const` at the top level of script.js,
// which loads before this file, so it's already in scope here.
function wireBellRefresh() {
    if (typeof notificationBell !== "undefined" && notificationBell) {
        notificationBell.addEventListener("click", function () {
            loadNotifications();
        });
    }
}

// The staff profile loads asynchronously after sign-in, so poll briefly
// (same pattern used elsewhere in this app, e.g. timesheet.js) rather than
// assuming it's ready the instant the DOM is.
function initNotifications(attempts) {
    attempts = attempts || 0;
    const clientReady = !!window.supabaseClient;
    const profileReady = !!getNotificationsStaffProfile();

    if (clientReady && (profileReady || attempts >= 25)) {
        loadNotifications();
        return;
    }
    if (attempts >= 25) {
        if (clientReady) loadNotifications();
        return;
    }
    setTimeout(function () { initNotifications(attempts + 1); }, 200);
}

function startNotifications() {
    wireMarkReadButton();
    wireBellRefresh();
    initNotifications();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startNotifications);
} else {
    startNotifications();
}
