/* ===========================
   SIDEBAR "NEEDS YOUR APPROVAL" BADGE — shared, every page that carries the
   sidebar (see #accountActivityNavItem / #accountActivityNavBadge).

   Shows a small red count badge on the Account Activity nav link whenever
   the signed-in staff member is the assigned approver on one or more
   incident reports still sitting in pending_approval — so it's visible
   from anywhere in the app, not just after opening Account Activity itself.
   Coleby: "can we add a notfcation to the side bar when there is a form
   that needs aproving?"

   Same "poll briefly for the profile/client to be ready" pattern used
   elsewhere in this app (notifications.js, nav-access.js). This app
   doesn't use Supabase Realtime anywhere, so there's no live push here
   either -- this checks once on load, then again every
   NAV_APPROVALS_POLL_MS while the page stays open, which is enough for a
   sidebar count (the same report also refreshes instantly whenever you
   land on Account Activity itself, which loads its own copy of this data).
=========================== */

const NAV_APPROVALS_POLL_MS = 60000;

function navApprovalsGetProfile() {
    if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
    try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); }
    catch { return null; }
}

function navApprovalsGetStaffId() {
    const profile = navApprovalsGetProfile();
    return profile?.id || profile?.uid || null;
}

function renderNavApprovalsBadge(count) {
    const badge = document.getElementById("accountActivityNavBadge");
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 9 ? "9+" : String(count);
        badge.style.display = "inline-flex";
    } else {
        badge.style.display = "none";
    }
}

async function loadNavApprovalsBadge() {
    if (!window.supabaseClient) return;
    const staffId = navApprovalsGetStaffId();
    if (!staffId) { renderNavApprovalsBadge(0); return; }

    const { count, error } = await window.supabaseClient
        .from("incident_reports")
        .select("id", { count: "exact", head: true })
        .eq("assigned_approver_id", staffId)
        .eq("status", "pending_approval");

    if (error) {
        // incident_reports most likely doesn't exist yet on this install
        // (the SQL migration hasn't been run) -- fail quiet and just leave
        // the badge hidden, same fail-open spirit as nav-access.js.
        console.warn("nav-approvals-badge: couldn't load pending-approval count:", error);
        return;
    }

    renderNavApprovalsBadge(count || 0);
}

function pollAndInitNavApprovalsBadge(attempts) {
    attempts = attempts || 0;
    const clientReady = !!window.supabaseClient;
    const profileReady = !!navApprovalsGetProfile();

    if (clientReady && (profileReady || attempts >= 25)) {
        loadNavApprovalsBadge();
        setInterval(loadNavApprovalsBadge, NAV_APPROVALS_POLL_MS);
        return;
    }
    setTimeout(function () { pollAndInitNavApprovalsBadge(attempts + 1); }, 200);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { pollAndInitNavApprovalsBadge(); });
} else {
    pollAndInitNavApprovalsBadge();
}
