/* ===========================
   MORNING CHECK — loaded on every signed-in page.

   The first time each person opens the portal on a given day, send them to
   /pages/good-morning.html (with ?next= so "Continue" brings them back to
   wherever they were headed). After that, stay out of the way for the rest
   of the day.

   "Seen today" lives server-side in `morning_update_seen`
   (sql/supabase-morning-update-setup.sql) so it's once per person, not per
   browser. A localStorage copy of today's date short-circuits the check so
   every later page load that day costs nothing.

   Fails open: if the table doesn't exist yet or anything errors, the page
   just loads normally.
=========================== */

(function () {
    const lastSegment = (window.location.pathname.split("/").pop() || "").replace(/\.html$/i, "");
    // Never redirect from the login screen, the morning page itself, or root.
    if (["", "index", "login", "good-morning"].includes(lastSegment)) return;

    // Today's date in the office's time zone, as YYYY-MM-DD.
    function officeToday() {
        return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    }
    window.getOfficeToday = officeToday;

    async function check() {
        const profile = await (window.supabaseInitialProfilePromise || Promise.resolve(null));
        if (!profile || profile.must_reset_password || !window.supabaseClient) return;

        const today = officeToday();
        const cacheKey = `morningSeen:${profile.id}`;
        try { if (localStorage.getItem(cacheKey) === today) return; } catch {}

        const { data, error } = await window.supabaseClient
            .from("morning_update_seen")
            .select("last_seen_date")
            .eq("staff_user_id", profile.id)
            .maybeSingle();

        if (error) { console.warn("morning-check: skipping, couldn't read seen state", error); return; }

        if (data && data.last_seen_date === today) {
            try { localStorage.setItem(cacheKey, today); } catch {}
            return;
        }

        const next = window.location.pathname + window.location.search + window.location.hash;
        window.location.replace(`/pages/good-morning.html?next=${encodeURIComponent(next)}`);
    }

    check().catch(err => console.warn("morning-check failed:", err));
})();
