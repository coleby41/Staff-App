/* ===========================
   GOOD MORNING — pages/good-morning.html

   Once-a-day summary of what changed since this person last saw it, plus
   their unread notifications. js/morning-check.js sends people here on
   their first page load of the day; "Continue" takes them on to wherever
   they were going (?next=).

   "Since" = their previous morning_update_seen.last_seen_at (capped at 7
   days back, so someone back from vacation gets a readable page, not a
   wall). First-ever visit falls back to the last 24 hours.

   Every section loads independently and fails quiet — a table this person
   can't read (RLS) or that doesn't exist just leaves that section out,
   rather than breaking the whole page. Things this person did themselves
   (their own uploads, posts, edits) are left out — they already know.
=========================== */

(function () {
    const MAX_LOOKBACK_DAYS = 7;

    const esc = (str) => {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    };

    function officeToday() {
        return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    }

    // Only allow same-site paths for ?next= (no "//evil.com" or full URLs).
    function getNextUrl() {
        const next = new URLSearchParams(window.location.search).get("next");
        if (next && next.startsWith("/") && !next.startsWith("//") && !/good-morning/i.test(next)) return next;
        return "/pages/dashboard.html";
    }

    function greeting() {
        const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date()));
        if (hour < 12) return "Good morning";
        if (hour < 17) return "Good afternoon";
        return "Good evening";
    }

    function timeAgo(iso) {
        if (!iso) return "";
        const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.round(hrs / 24);
        return days === 1 ? "yesterday" : `${days}d ago`;
    }

    function formatSince(iso) {
        return new Date(iso).toLocaleString("en-US", {
            timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
        });
    }

    function formatDue(dateStr) {
        if (!dateStr) return "";
        const today = officeToday();
        if (dateStr === today) return "Due today";
        if (dateStr < today) return `Overdue · was due ${new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
        return `Due ${new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    }

    const labelize = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    // Runs a query and returns rows, or [] if it errors (RLS, missing table…).
    async function rows(label, query) {
        try {
            const { data, error } = await query;
            if (error) { console.warn(`good-morning: ${label} skipped`, error); return []; }
            return data || [];
        } catch (err) {
            console.warn(`good-morning: ${label} skipped`, err);
            return [];
        }
    }

    /* ---------- seen state ---------- */

    async function readAndStampSeen(staffId) {
        const sb = window.supabaseClient;
        const { data } = await sb.from("morning_update_seen")
            .select("last_seen_at").eq("staff_user_id", staffId).maybeSingle();

        const floor = Date.now() - MAX_LOOKBACK_DAYS * 86400000;
        let since = data?.last_seen_at ? new Date(data.last_seen_at).getTime() : Date.now() - 86400000;
        if (since < floor) since = floor;

        // Stamp now, before the (slower) loads below, so a refresh or a
        // second tab doesn't bounce them here again.
        const today = officeToday();
        const { error } = await sb.from("morning_update_seen").upsert({
            staff_user_id: staffId, last_seen_at: new Date().toISOString(), last_seen_date: today
        }, { onConflict: "staff_user_id" });
        if (error) console.warn("good-morning: couldn't save seen state", error);
        try { localStorage.setItem(`morningSeen:${staffId}`, today); } catch {}

        return new Date(since).toISOString();
    }

    /* ---------- loaders (each returns an array of display items) ---------- */

    async function loadNotifications(staffId) {
        const sb = window.supabaseClient;
        const all = await rows("notifications", sb.from("notifications").select("*")
            .or(`user_id.is.null,user_id.eq.${staffId}`)
            .order("created_at", { ascending: false }).limit(20));
        if (!all.length) return [];

        const reads = await rows("notification reads", sb.from("notification_reads")
            .select("notification_id").eq("staff_user_id", staffId).in("notification_id", all.map(n => n.id)));
        const readIds = new Set(reads.map(r => r.notification_id));

        const unread = all.filter(n => !readIds.has(n.id));
        const items = unread.map(n => ({
            title: n.title, detail: n.message, when: n.created_at,
            link: n.link_url, linkLabel: n.link_label || "View it here"
        }));
        items.rawIds = unread; // for markNotificationsToasted()
        return items;
    }

    async function loadMyStuff(staffId, since) {
        const sb = window.supabaseClient;
        const today = officeToday();
        const [tasks, subitems, myReports, toApprove, employee] = await Promise.all([
            rows("my tasks", sb.from("tasks").select("id, task_name, due_date")
                .eq("user_id", staffId).eq("completed", false).lte("due_date", today).order("due_date")),
            rows("assigned to-dos", sb.from("project_todo_subitems").select("id, label, due_date, created_at, project_id, projects(name)")
                .eq("assigned_to", staffId).eq("completed", false).order("due_date", { ascending: true, nullsFirst: false })),
            rows("my incident reports", sb.from("incident_reports").select("id, status, decided_at, projects(name)")
                .eq("submitted_by", staffId).gt("decided_at", since)),
            rows("reports to approve", sb.from("incident_reports").select("id, submitted_by_name, created_at, projects(name)")
                .eq("assigned_approver_id", staffId).eq("status", "pending_approval")),
            rows("payroll employee", sb.from("payroll_employees").select("id").eq("staff_id", staffId).limit(1))
        ]);

        const timesheets = employee.length
            ? await rows("timesheets", sb.from("timesheets").select("id, status, updated_at")
                .eq("payroll_employee_id", employee[0].id).gt("updated_at", since).order("updated_at", { ascending: false }).limit(3))
            : [];

        const items = [];
        tasks.forEach(t => items.push({ title: t.task_name, detail: formatDue(t.due_date), link: "/pages/staff-todo.html", linkLabel: "Open To-Do", urgent: t.due_date < today }));
        subitems
            // Newly assigned since last visit, or due today / overdue.
            .filter(s => s.created_at > since || (s.due_date && s.due_date <= today))
            .forEach(s => items.push({
                title: s.label,
                detail: [s.projects?.name, s.due_date ? formatDue(s.due_date) : (s.created_at > since ? "Newly assigned to you" : "")].filter(Boolean).join(" · "),
                link: `/pages/project-todo.html?id=${encodeURIComponent(s.project_id)}`, linkLabel: "Open project to-do",
                urgent: !!s.due_date && s.due_date < today
            }));
        toApprove.forEach(r => items.push({
            title: "Incident report waiting on your approval",
            detail: [r.projects?.name, r.submitted_by_name ? `from ${r.submitted_by_name}` : ""].filter(Boolean).join(" · "),
            when: r.created_at, link: "/pages/account-activity.html", linkLabel: "Review it", urgent: true
        }));
        myReports.forEach(r => items.push({
            title: `Your incident report was ${r.status === "approved" ? "approved" : "rejected"}`,
            detail: r.projects?.name || "", when: r.decided_at, link: "/pages/account-activity.html", linkLabel: "View it"
        }));
        timesheets.forEach(t => items.push({
            title: `Timesheet: ${t.status}`, when: t.updated_at, link: "/pages/timesheet.html", linkLabel: "Open timesheet",
            urgent: t.status === "Needs Corrections"
        }));
        return items;
    }

    async function loadCompanyUpdates(staffId, since) {
        const list = await rows("company updates", window.supabaseClient.from("company_updates")
            .select("id, title, description, author_name, author_id, created_at")
            .gt("created_at", since).order("created_at", { ascending: false }));
        return list.filter(u => u.author_id !== staffId).map(u => ({
            title: u.title, detail: [u.author_name, u.description].filter(Boolean).join(" — "), when: u.created_at
        }));
    }

    async function loadProjectChanges(staffId, since) {
        const sb = window.supabaseClient;
        const [projects, timeline, todos] = await Promise.all([
            rows("projects", sb.from("projects").select("id, name, status, created_at, updated_at, created_by_id, created_by_name, updated_by_id, updated_by_name")
                .gt("updated_at", since).order("updated_at", { ascending: false })),
            rows("timeline", sb.from("project_timeline_items").select("id, project_id, title, type, status, updated_at, projects(name)")
                .gt("updated_at", since).order("updated_at", { ascending: false }).limit(30)),
            rows("project to-dos", sb.from("project_todo_items").select("id, project_id, title, created_at, created_by_id, created_by_name, projects(name)")
                .gt("created_at", since).order("created_at", { ascending: false }).limit(30))
        ]);

        const items = [];
        projects.forEach(p => {
            const isNew = p.created_at > since;
            const byMe = String(isNew ? p.created_by_id : p.updated_by_id) === String(staffId);
            if (byMe) return;
            const who = isNew ? p.created_by_name : p.updated_by_name;
            items.push({
                title: isNew ? `New project: ${p.name || "Untitled"}` : `${p.name || "Untitled"} was updated`,
                detail: [labelize(p.status), who ? `by ${who}` : ""].filter(Boolean).join(" · "),
                when: isNew ? p.created_at : p.updated_at,
                link: `/pages/projects.html?id=${encodeURIComponent(p.id)}`, linkLabel: "Open project"
            });
        });
        timeline.forEach(t => items.push({
            title: `${t.projects?.name || "Project"}: ${t.title}`,
            detail: `Timeline ${t.type} · ${labelize(t.status)}`, when: t.updated_at,
            link: `/pages/project-timeline.html?id=${encodeURIComponent(t.project_id)}`, linkLabel: "Open timeline"
        }));
        todos.filter(t => t.created_by_id !== staffId).forEach(t => items.push({
            title: `${t.projects?.name || "Project"}: new to-do "${t.title}"`,
            detail: t.created_by_name ? `Added by ${t.created_by_name}` : "", when: t.created_at,
            link: `/pages/project-todo.html?id=${encodeURIComponent(t.project_id)}`, linkLabel: "Open to-do"
        }));
        return items.sort((a, b) => String(b.when).localeCompare(String(a.when)));
    }

    async function loadFilesAndForms(staffId, since) {
        const sb = window.supabaseClient;
        const [files, forms] = await Promise.all([
            rows("project files", sb.from("project_files").select("id, project_id, file_name, category, uploaded_by, uploaded_by_name, source, created_at, projects(name)")
                .gt("created_at", since).order("created_at", { ascending: false }).limit(30)),
            rows("form submissions", sb.from("form_submissions").select("id, form_title, file_name, submitted_by, submitted_by_name, created_at")
                .gt("created_at", since).order("created_at", { ascending: false }).limit(30))
        ]);

        const items = [];
        files.filter(f => f.uploaded_by !== staffId && f.source !== "form_submission").forEach(f => items.push({
            title: f.file_name,
            detail: [f.projects?.name, labelize(f.category), f.uploaded_by_name ? `uploaded by ${f.uploaded_by_name}` : ""].filter(Boolean).join(" · "),
            when: f.created_at, link: `/pages/project-files.html?id=${encodeURIComponent(f.project_id)}`, linkLabel: "Open files"
        }));
        forms.filter(f => f.submitted_by !== staffId).forEach(f => items.push({
            title: f.file_name || f.form_title || "Form submission",
            detail: [f.form_title && f.file_name ? f.form_title : "", f.submitted_by_name ? `submitted by ${f.submitted_by_name}` : ""].filter(Boolean).join(" · "),
            when: f.created_at, link: "/pages/form-template.html", linkLabel: "Open forms"
        }));
        return items.sort((a, b) => String(b.when).localeCompare(String(a.when)));
    }

    /* ---------- onboarding-style steps ---------- */

    const SECTIONS = [
        { key: "notifications", title: "New notifications", blurb: "Things people sent your way.", tone: "yellow",
          icon: '<path d="M18 16H6l1.4-1.6V10a4.6 4.6 0 019.2 0v4.4L18 16zM10 18.5a2 2 0 004 0"/>' },
        { key: "mine", title: "For you", blurb: "What's on your plate today.", tone: "blue",
          icon: '<path d="M9 11l2.5 2.5L16 9"/><rect x="4" y="4" width="16" height="16" rx="3"/>' },
        { key: "updates", title: "Company updates", blurb: "What's new around the office.", tone: "green",
          icon: '<path d="M4 10v4h3l5 4V6L7 10H4zM16 9a4 4 0 010 6"/>' },
        { key: "projects", title: "Project changes", blurb: "Movement on the jobs.", tone: "navy",
          icon: '<path d="M3 20h18M5 20V9l7-5 7 5v11M10 20v-5h4v5"/>' },
        { key: "files", title: "New files & forms", blurb: "Fresh uploads and submissions.", tone: "purple",
          icon: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zM14 3v5h5"/>' }
    ];

    const MAX_PER_STEP = 6;
    const state = { steps: [], index: 0, data: {}, since: null, greetingText: "", nextUrl: "/pages/dashboard.html" };

    const iconSvg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

    function itemHtml(item) {
        return `
            <li class="gm-item${item.urgent ? " gm-item--urgent" : ""}">
                <div class="gm-item-main">
                    <p class="gm-item-title">${esc(item.title)}</p>
                    ${item.detail ? `<p class="gm-item-detail">${esc(item.detail)}</p>` : ""}
                </div>
                <div class="gm-item-side">
                    ${item.when ? `<span class="gm-item-when">${esc(timeAgo(item.when))}</span>` : ""}
                    ${item.link ? `<a class="gm-item-link" href="${esc(item.link)}">${esc(item.linkLabel || "Open")}</a>` : ""}
                </div>
            </li>`;
    }

    function renderWelcome() {
        const active = SECTIONS.filter(sec => state.data[sec.key].length);
        const dateLine = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" });

        if (!active.length) {
            return `
                <p class="gm-eyebrow">${esc(dateLine)}</p>
                <h1 class="gm-title">${esc(state.greetingText)}</h1>
                <div class="gm-caught-up">
                    <span class="gm-hero-icon gm-tone-green">${iconSvg('<path d="M6 12.5l4 4 8-9"/>')}</span>
                    <p class="gm-lede">You're all caught up. Nothing new since ${esc(formatSince(state.since))}.</p>
                </div>`;
        }

        return `
            <p class="gm-eyebrow">${esc(dateLine)}</p>
            <h1 class="gm-title">${esc(state.greetingText)}</h1>
            <p class="gm-lede">Here's what changed since ${esc(formatSince(state.since))}. Let's walk through it.</p>
            <div class="gm-tiles">
                ${active.map(sec => `
                    <button type="button" class="gm-tile" data-jump="${sec.key}">
                        <span class="gm-tile-icon gm-tone-${sec.tone}">${iconSvg(sec.icon)}</span>
                        <span class="gm-tile-count">${state.data[sec.key].length}</span>
                        <span class="gm-tile-label">${esc(sec.title)}</span>
                    </button>`).join("")}
            </div>`;
    }

    function renderSectionStep(sec) {
        const items = state.data[sec.key];
        const shown = items.slice(0, MAX_PER_STEP);
        return `
            <div class="gm-step-head">
                <span class="gm-hero-icon gm-tone-${sec.tone}">${iconSvg(sec.icon)}</span>
                <div>
                    <h2 class="gm-title gm-title--sm">${esc(sec.title)} <span class="gm-count gm-tone-${sec.tone}">${items.length}</span></h2>
                    <p class="gm-lede gm-lede--sm">${esc(sec.blurb)}</p>
                </div>
            </div>
            <ul class="gm-list">
                ${shown.map(itemHtml).join("")}
                ${items.length > shown.length ? `<li class="gm-more">and ${items.length - shown.length} more</li>` : ""}
            </ul>`;
    }

    function renderDone() {
        return `
            <div class="gm-caught-up">
                <span class="gm-hero-icon gm-tone-green">${iconSvg('<path d="M6 12.5l4 4 8-9"/>')}</span>
                <h2 class="gm-title">You're all set</h2>
                <p class="gm-lede">That's everything. Have a good day.</p>
            </div>`;
    }

    function render() {
        const step = state.steps[state.index];
        const stepEl = document.getElementById("gmStep");
        const isLast = state.index === state.steps.length - 1;

        stepEl.classList.remove("gm-step--in");
        void stepEl.offsetWidth; // restart the slide-in animation
        stepEl.innerHTML = step.type === "welcome" ? renderWelcome()
            : step.type === "done" ? renderDone()
            : renderSectionStep(step.section);
        stepEl.classList.add("gm-step--in");

        stepEl.querySelectorAll("[data-jump]").forEach(btn => btn.addEventListener("click", () => {
            const target = state.steps.findIndex(s => s.section?.key === btn.dataset.jump);
            if (target > -1) go(target);
        }));

        document.getElementById("gmDots").innerHTML = state.steps.length > 1
            ? state.steps.map((_, i) => `<span class="gm-dot${i === state.index ? " gm-dot--on" : ""}${i < state.index ? " gm-dot--done" : ""}"></span>`).join("")
            : "";
        document.getElementById("gmStepCount").textContent = state.steps.length > 1 ? `${state.index + 1} of ${state.steps.length}` : "";
        document.getElementById("gmBackBtn").hidden = state.index === 0;

        const nextBtn = document.getElementById("gmNextBtn");
        nextBtn.disabled = false;
        nextBtn.innerHTML = isLast ? "Let's go &rarr;"
            : state.index === 0 ? "Get started &rarr;"
            : "Next &rarr;";
    }

    function go(index) {
        state.index = Math.max(0, Math.min(state.steps.length - 1, index));
        render();
    }

    function finish() { window.location.href = state.nextUrl; }

    // The notifications shown here shouldn't pop as yellow toasts on the
    // next page either (see toastNewNotifications() in notifications.js).
    function markNotificationsToasted(list) {
        try {
            const key = "toastedNotificationIds";
            const ids = new Set(JSON.parse(localStorage.getItem(key) || "[]"));
            list.forEach(n => ids.add(n.id));
            localStorage.setItem(key, JSON.stringify([...ids].slice(-200)));
        } catch {}
    }

    async function init() {
        state.nextUrl = getNextUrl();
        document.getElementById("gmSkipBtn").addEventListener("click", finish);
        document.getElementById("gmBackBtn").addEventListener("click", () => go(state.index - 1));
        document.getElementById("gmNextBtn").addEventListener("click", () => {
            if (state.index >= state.steps.length - 1) finish(); else go(state.index + 1);
        });
        document.addEventListener("keydown", (e) => {
            if (!state.steps.length || e.target.closest?.("a, input, textarea")) return;
            if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); document.getElementById("gmNextBtn").click(); }
            if (e.key === "ArrowLeft" && state.index > 0) go(state.index - 1);
        });

        const profile = await (window.supabaseInitialProfilePromise || Promise.resolve(null));
        if (!profile || !window.supabaseClient) return; // auth-guard.js handles the redirect to login

        const firstName = String(profile.full_name || profile.username || "").trim().split(/\s+/)[0];
        state.greetingText = `${greeting()}${firstName ? `, ${firstName}` : ""}`;
        state.since = await readAndStampSeen(profile.id);

        const [notifications, mine, updates, projects, files] = await Promise.all([
            loadNotifications(profile.id),
            loadMyStuff(profile.id, since()),
            loadCompanyUpdates(profile.id, since()),
            loadProjectChanges(profile.id, since()),
            loadFilesAndForms(profile.id, since())
        ]);
        state.data = { notifications, mine, updates, projects, files };
        markNotificationsToasted(notifications.rawIds || []);

        const active = SECTIONS.filter(sec => state.data[sec.key].length);
        state.steps = [{ type: "welcome" }, ...active.map(sec => ({ type: "section", section: sec }))];
        if (active.length) state.steps.push({ type: "done" });
        render();
    }

    function since() { return state.since; }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
