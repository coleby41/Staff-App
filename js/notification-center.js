/* ===========================
   NOTIFICATION CENTER (pages/notifications.html)
   Full history behind the bell's "See all" link. The bell dropdown only
   shows the newest 4 UNREAD; this page shows everything (read + unread),
   newest first, 25 at a time with "Load more".

   Reuses helpers from js/notifications.js (loaded before this file):
   getNotificationsStaffId(), notifyEscapeHtml(), loadNotifications().
   Same anon-role + app-level user_id filtering as the rest of the app
   (auth.uid() is always null here).
=========================== */

const NC_PAGE_SIZE = 25;

let ncItems = [];          // everything loaded so far, newest first
let ncReadIds = new Set(); // ids this staff member has read
let ncOffset = 0;
let ncHasMore = true;
let ncFilter = "all";      // "all" | "unread"

function ncFormatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}h ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function ncLoadPage() {
    const userId = getNotificationsStaffId();
    const moreBtn = document.getElementById("ncLoadMoreBtn");
    if (moreBtn) moreBtn.disabled = true;

    let query = window.supabaseClient
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .range(ncOffset, ncOffset + NC_PAGE_SIZE - 1);

    query = userId
        ? query.or(`user_id.is.null,user_id.eq.${userId}`)
        : query.is("user_id", null);

    const { data, error } = await query;
    if (moreBtn) moreBtn.disabled = false;
    if (error) { console.error("Notification center load failed:", error); return; }

    const rows = data || [];
    ncHasMore = rows.length === NC_PAGE_SIZE;
    ncOffset += rows.length;

    if (userId && rows.length) {
        const { data: readRows, error: readError } = await window.supabaseClient
            .from("notification_reads")
            .select("notification_id")
            .eq("staff_user_id", userId)
            .in("notification_id", rows.map(n => n.id));
        if (readError) console.error("Failed to load read state:", readError);
        else (readRows || []).forEach(r => ncReadIds.add(r.notification_id));
    }

    ncItems = ncItems.concat(rows);
    ncRender();
}

function ncRender() {
    const list = document.getElementById("ncList");
    const empty = document.getElementById("ncEmpty");
    const moreWrap = document.getElementById("ncLoadMoreWrap");
    const unreadCount = ncItems.filter(n => !ncReadIds.has(n.id)).length;

    const countEl = document.getElementById("ncUnreadCount");
    if (countEl) countEl.textContent = unreadCount ? `${unreadCount} unread` : "All caught up";

    const markAllBtn = document.getElementById("ncMarkAllBtn");
    if (markAllBtn) markAllBtn.disabled = unreadCount === 0;

    const shown = ncFilter === "unread"
        ? ncItems.filter(n => !ncReadIds.has(n.id))
        : ncItems;

    list.innerHTML = "";
    empty.classList.toggle("hidden", shown.length > 0);
    empty.textContent = ncFilter === "unread" ? "No unread notifications." : "No notifications yet.";

    shown.forEach(n => {
        const isRead = ncReadIds.has(n.id);
        const row = document.createElement("div");
        row.className = "nc-item" + (isRead ? "" : " nc-item--unread");
        const linkHtml = n.link_url
            ? `<a class="notification-link" href="${notifyEscapeHtml(n.link_url)}" data-nc-id="${n.id}">${notifyEscapeHtml(n.link_label || "View it here")}</a>`
            : "";
        row.innerHTML = `
            <span class="nc-dot" aria-hidden="true"></span>
            <div class="nc-body">
                <div class="nc-top">
                    <strong>${notifyEscapeHtml(n.title)}</strong>
                    <span class="nc-time">${ncFormatDate(n.created_at)}</span>
                </div>
                <p>${notifyEscapeHtml(n.message)}</p>
                ${linkHtml}
            </div>
            ${isRead ? "" : `<button type="button" class="mark-read-btn nc-mark-btn" data-nc-id="${n.id}">Mark read</button>`}
        `;
        list.appendChild(row);
    });

    moreWrap.classList.toggle("hidden", !ncHasMore);
}

async function ncMarkRead(ids) {
    const userId = getNotificationsStaffId();
    ids = ids.filter(id => !ncReadIds.has(id));
    if (!userId || !ids.length) return;

    const { error } = await window.supabaseClient
        .from("notification_reads")
        .upsert(ids.map(id => ({ notification_id: id, staff_user_id: userId })),
                { onConflict: "notification_id,staff_user_id", ignoreDuplicates: true });
    if (error) { console.error("Failed to mark read:", error); return; }

    ids.forEach(id => ncReadIds.add(id));
    ncRender();
    // Keep the bell badge/dropdown in sync with what just changed here.
    if (typeof loadNotifications === "function") loadNotifications();
}

function ncWire() {
    document.getElementById("ncLoadMoreBtn").addEventListener("click", ncLoadPage);

    document.getElementById("ncMarkAllBtn").addEventListener("click", function () {
        ncMarkRead(ncItems.map(n => n.id));
    });

    document.querySelectorAll(".nc-filter-btn").forEach(btn => {
        btn.addEventListener("click", function () {
            ncFilter = btn.dataset.filter;
            document.querySelectorAll(".nc-filter-btn").forEach(b =>
                b.classList.toggle("nc-filter-btn--active", b === btn));
            ncRender();
        });
    });

    // One delegated listener: "Mark read" buttons, and clicking a
    // notification's link also counts as reading it.
    document.getElementById("ncList").addEventListener("click", function (e) {
        const btn = e.target.closest(".nc-mark-btn");
        if (btn) { ncMarkRead([btn.dataset.ncId]); return; }
        const link = e.target.closest(".notification-link[data-nc-id]");
        if (link) ncMarkRead([link.dataset.ncId]);
    });
}

// Same profile-polling pattern as notifications.js / timesheet.js.
function ncInit(attempts) {
    attempts = attempts || 0;
    if (window.supabaseClient && (getNotificationsStaffProfile() || attempts >= 25)) {
        ncLoadPage();
        return;
    }
    setTimeout(function () { ncInit(attempts + 1); }, 200);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { ncWire(); ncInit(); });
} else {
    ncWire(); ncInit();
}
