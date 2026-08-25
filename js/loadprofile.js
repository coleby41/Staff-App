/* ===========================
   LOAD PROFILE
=========================== */


const storedProfile =
    localStorage.getItem("staffProfile");



if (storedProfile) {


    try {


        const parsedProfile =
            JSON.parse(storedProfile);



        updateStaffName(parsedProfile);

        updateNavAccess(parsedProfile);



    } catch(error) {


        console.warn(
            "Unable to parse stored profile:",
            error
        );


    }


}






window.addEventListener("DOMContentLoaded", function() {


    const profile =
        window.currentSupabaseProfile || null;



    if (profile) {


        updateStaffName(profile);

        updateNavAccess(profile);


    }


    loadNotifications();


});



/* ===========================
   NOTIFICATIONS (Supabase)
   Uses window.supabaseClient, exposed globally by supabase-auth.js.
   Reads broadcast notifications (user_id null, e.g. announcements) plus
   anything targeted at this specific user (e.g. timesheet approvals).
   "Read" state is tracked client-side in localStorage — fine for a
   single-browser-per-person setup; move it server-side later if you
   need read state to follow someone across devices.
=========================== */

let currentNotifications = [];
const READ_IDS_KEY = 'readNotificationIds';

function escapeHtmlLocal(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

function getReadNotificationIds() {
    try { return new Set(JSON.parse(localStorage.getItem(READ_IDS_KEY) || '[]')); }
    catch { return new Set(); }
}

function markNotificationsRead(ids) {
    const read = getReadNotificationIds();
    ids.forEach(id => read.add(id));
    localStorage.setItem(READ_IDS_KEY, JSON.stringify([...read]));
}

async function loadNotifications() {
    if (!window.supabaseClient) { console.error('Supabase client not ready yet'); return; }

    const profile = window.currentSupabaseProfile
        || JSON.parse(localStorage.getItem('staffProfile') || 'null');
    const userId = profile?.id || profile?.uid || null;

    let query = window.supabaseClient
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);

    query = userId
        ? query.or(`user_id.is.null,user_id.eq.${userId}`)
        : query.is('user_id', null);

    const { data, error } = await query;
    if (error) { console.error('Failed to load notifications:', error); return; }

    currentNotifications = data || [];
    renderNotifications();
}

function renderNotifications() {
    const list = document.getElementById('notificationList');
    const empty = document.getElementById('notificationEmpty');
    const countEl = document.querySelector('.notification-count');
    const readIds = getReadNotificationIds();
    const unreadCount = currentNotifications.filter(n => !readIds.has(n.id)).length;

    if (countEl) {
        if (unreadCount > 0) {
            countEl.style.display = 'inline-flex';
            countEl.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
        } else {
            countEl.style.display = 'none';
        }
    }

    if (!list) return;
    list.innerHTML = '';

    if (currentNotifications.length === 0) {
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';

    currentNotifications.forEach(n => {
        const div = document.createElement('div');
        div.className = 'notification-item';
        div.innerHTML = `
            <strong>${escapeHtmlLocal(n.title)}</strong>
            <p>${escapeHtmlLocal(n.message)}</p>
        `;
        list.appendChild(div);
    });
}

// Mark everything currently loaded as read the moment the bell is opened.
// notificationBell/notificationDropdown are declared in script.js, which loads
// before this block, so they're already available here.
if (typeof notificationBell !== 'undefined' && notificationBell) {
    notificationBell.addEventListener("click", function () {
        if (currentNotifications.length === 0) return;
        markNotificationsRead(currentNotifications.map(n => n.id));
        renderNotifications(); // just updates the badge; list itself stays the same
    });
}