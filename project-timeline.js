/* ===========================================================
   PROJECT TIMELINE (project-timeline.html)

   A Gantt chart for a single project: phases, tasks, and milestones, all
   in one project_timeline_items table (see SQL FILES/
   supabase-project-timeline-setup.sql for the full schema rationale).
   Rendered with Frappe Gantt (https://github.com/frappe/gantt, MIT,
   loaded via CDN in project-timeline.html — the only charting library
   this app uses, and only on this page).

   Phase 1 (this file): a solid, reliable Gantt view — add/edit/delete via
   a side panel (same slide-in pattern as project-to-do.html's #todoPanel),
   status/progress coloring, overdue/upcoming/completed stats, and project
   to-dos with a due_date merged in live as read-only markers. The chart
   itself is rendered `readonly: true` — editing happens through the
   panel's form, not by dragging bars. Dragging bars directly (and
   rendering it as a first-class interaction with its own review pass) is
   a deliberate follow-up, not done here.

   Week/Month/Quarter/Year are real date windows anchored on today (this
   Mon–Sun, this calendar month, this calendar quarter, this calendar
   year) — see getPeriodWindow()/windowTasks() in the "Gantt rendering"
   section below — not just a zoom/density toggle over the whole project.

   Waits for "project-shell:ready" (project-shell.js) to know which
   project we're on, same as every other project-*.html page.

   Tables: project_timeline_items (this page's own data) and
   project_todo_subitems (read-only, for the due-date markers — see the
   "MERGE PROJECT TO-DOS" section below for why these are merged live
   instead of copied in).
=========================================================== */

(function () {
    "use strict";

    const TIMELINE_TABLE = "project_timeline_items";
    const TODO_SUBITEMS_TABLE = "project_todo_subitems";

    let currentProject = null;
    let timelineItems = [];   // project_timeline_items rows for this project
    let todoMarkers = [];     // project_todo_subitems rows (this project, due_date set) — read-only on this page
    let staffDirectory = [];  // [{ id, full_name }] — active staff, for assignee pickers
    let gantt = null;         // the live Frappe Gantt instance, once first rendered
    let currentViewMode = "Week";
    let editingItemId = null; // null while the panel is in "create" mode
    let pendingDeleteId = null;

    /* ---------- helpers ---------- */

    function escapeHtmlTimeline(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function getTimelineStaffProfile() {
        return window.currentSupabaseProfile
            || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    }

    function getTimelineStaffName() {
        const profile = getTimelineStaffProfile();
        return (profile && (profile.full_name || profile.username)) || "Staff";
    }

    function getTimelineStaffId() {
        const profile = getTimelineStaffProfile();
        return profile?.id || profile?.uid || null;
    }

    function setTimelinePageMessage(text, type) {
        const el = document.getElementById("timelinePageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; return; }
        el.textContent = text;
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = "block";
        if (type === "success") setTimeout(() => { el.style.display = "none"; }, 4000);
    }

    function setTimelinePanelMessage(text, type) {
        const el = document.getElementById("timelinePanelMessage");
        if (!el) return;
        el.textContent = text || "";
        el.className = `auth-message ${type || ""}`.trim();
    }

    // Plain YYYY-MM-DD string helpers — every date in this file is a plain
    // date string (matching Postgres `date` columns and the format Frappe
    // Gantt's task.start/task.end expect), never a Date-with-time, so
    // string comparison (<, >, ===) is safe and used throughout instead of
    // constructing Date objects.
    function todayISODate() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function addDaysISO(iso, days) {
        const d = new Date(`${iso}T00:00:00`);
        d.setDate(d.getDate() + days);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    /* ---------- staff directory (assignee picker) ---------- */

    async function loadStaffDirectory() {
        if (!window.supabaseClient) return;
        const { data, error } = await window.supabaseClient
            .from("staff_users_directory")
            .select("id, full_name, active")
            .eq("active", true)
            .order("full_name", { ascending: true });

        if (error) {
            console.error("Failed to load staff directory:", error);
            return;
        }
        staffDirectory = data || [];
    }

    function assigneeOptionsHtml(selectedId) {
        const options = [`<option value="">Unassigned</option>`];
        staffDirectory.forEach(person => {
            const selected = String(person.id) === String(selectedId) ? "selected" : "";
            options.push(`<option value="${person.id}" ${selected}>${escapeHtmlTimeline(person.full_name || "Staff")}</option>`);
        });
        return options.join("");
    }

    function staffNameById(id) {
        const match = staffDirectory.find(p => String(p.id) === String(id));
        return match ? (match.full_name || "Staff") : null;
    }

    /* ---------- loading ---------- */

    async function loadTimelineData(projectId) {
        const loadingEl = document.getElementById("timelineLoadingState");
        const emptyEl = document.getElementById("timelineEmptyState");
        const bodyEl = document.getElementById("timelineBody");
        if (loadingEl) loadingEl.style.display = "block";
        if (emptyEl) emptyEl.style.display = "none";
        if (bodyEl) bodyEl.style.display = "none";

        const [itemsResult, todoResult] = await Promise.all([
            window.supabaseClient
                .from(TIMELINE_TABLE)
                .select("*")
                .eq("project_id", projectId)
                .order("position", { ascending: true })
                .order("created_at", { ascending: true }),
            window.supabaseClient
                .from(TODO_SUBITEMS_TABLE)
                .select("id, label, due_date, completed, assigned_to_name")
                .eq("project_id", projectId)
                .not("due_date", "is", null)
        ]);

        if (loadingEl) loadingEl.style.display = "none";

        if (itemsResult.error || todoResult.error) {
            console.error("Failed to load project timeline:", itemsResult.error || todoResult.error);
            setTimelinePageMessage("Couldn't load this project's timeline. Please try again.", "error");
            return;
        }

        timelineItems = itemsResult.data || [];
        todoMarkers = todoResult.data || [];

        if (timelineItems.length === 0 && todoMarkers.length === 0) {
            if (emptyEl) emptyEl.style.display = "block";
            return;
        }

        if (bodyEl) bodyEl.style.display = "block";
        renderEverything();
    }

    /* ---------- stats ---------- */

    function computeAndRenderStats() {
        const today = todayISODate();
        const weekAhead = addDaysISO(today, 7);

        let overdue = 0, upcoming = 0, inProgress = 0, completed = 0;

        timelineItems.forEach(item => {
            if (item.status === "completed") { completed++; return; }
            if (item.end_date && item.end_date < today) { overdue++; return; }
            if (item.status === "in_progress") inProgress++;
            if (item.end_date && item.end_date >= today && item.end_date <= weekAhead) upcoming++;
        });

        todoMarkers.forEach(sub => {
            if (sub.completed) { completed++; return; }
            if (sub.due_date < today) { overdue++; return; }
            if (sub.due_date <= weekAhead) upcoming++;
        });

        const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
        set("timelineStatOverdue", overdue);
        set("timelineStatUpcoming", upcoming);
        set("timelineStatInProgress", inProgress);
        set("timelineStatCompleted", completed);
    }

    /* ---------- Gantt task building ---------- */

    function computeEffectiveStatus(status, endDate, today) {
        if (status === "completed") return "completed";
        if (endDate && endDate < today) return "overdue";
        return status || "not_started";
    }

    // A phase with no dates of its own spans whatever its children cover —
    // set explicit dates on the phase to override this.
    function getPhaseEffectiveDates(phase) {
        if (phase.start_date && phase.end_date) return { start: phase.start_date, end: phase.end_date };

        const children = timelineItems.filter(i => String(i.parent_id) === String(phase.id) && (i.start_date || i.end_date));
        if (!children.length) return { start: phase.start_date || null, end: phase.end_date || null };

        let minStart = null, maxEnd = null;
        children.forEach(child => {
            const start = child.start_date || child.end_date;
            const end = child.end_date || child.start_date;
            if (start && (!minStart || start < minStart)) minStart = start;
            if (end && (!maxEnd || end > maxEnd)) maxEnd = end;
        });

        return { start: phase.start_date || minStart, end: phase.end_date || maxEnd };
    }

    // Frappe Gantt hands the whole custom_class string straight to a single
    // classList.add() call rather than splitting it on spaces — passing
    // "type-x status-y" (space-separated, the normal multi-class approach)
    // throws InvalidCharacterError at render time since DOMTokenList tokens
    // can't contain spaces. So every semantic fragment (type, status,
    // whether it's a merged-in to-do) gets baked into one hyphen-joined
    // token instead, and the CSS below matches each fragment with a
    // [class*="..."] substring selector rather than a plain class selector.
    function buildGanttCustomClass(type, status, isTodo) {
        return `gantt-item-type-${type}-status-${status}${isTodo ? "-source-todo" : ""}`;
    }

    function buildGanttTasks() {
        const today = todayISODate();
        const tasks = [];

        function pushItemTask(item) {
            let start = item.start_date;
            let end = item.end_date;

            if (item.type === "phase") {
                const effective = getPhaseEffectiveDates(item);
                start = effective.start;
                end = effective.end;
            } else if (item.type === "milestone") {
                // Milestones are a single point in time (end_date only) —
                // give them a 1-day span so there's an actual bar to draw
                // and restyle as a marker (see .gantt-item-type-milestone
                // in styles.css).
                start = item.end_date;
                end = item.end_date ? addDaysISO(item.end_date, 1) : null;
            }

            if (!start || !end) return; // no dates set yet — nothing to plot

            const effectiveStatus = computeEffectiveStatus(item.status, item.end_date, today);
            const customClass = buildGanttCustomClass(item.type, effectiveStatus, false);

            tasks.push({
                id: String(item.id),
                name: item.title,
                start,
                end,
                progress: item.type === "milestone" ? (item.status === "completed" ? 100 : 0) : (item.progress || 0),
                dependencies: item.depends_on_id ? String(item.depends_on_id) : "",
                custom_class: customClass
            });
        }

        // Order: each phase immediately followed by its own children (in
        // position order), then top-level tasks/milestones with no phase.
        // Frappe Gantt renders tasks as a flat, ordered list of rows — this
        // ordering is what makes a phase read as a visual group with its
        // tasks, since the library has no built-in row-grouping/collapse.
        const phases = timelineItems.filter(i => i.type === "phase").sort((a, b) => a.position - b.position);
        const topLevel = timelineItems.filter(i => i.type !== "phase" && !i.parent_id).sort((a, b) => a.position - b.position);

        const childrenByPhase = {};
        timelineItems.forEach(i => {
            if (i.parent_id) (childrenByPhase[i.parent_id] = childrenByPhase[i.parent_id] || []).push(i);
        });
        Object.values(childrenByPhase).forEach(list => list.sort((a, b) => a.position - b.position));

        phases.forEach(phase => {
            pushItemTask(phase);
            (childrenByPhase[phase.id] || []).forEach(pushItemTask);
        });
        topLevel.forEach(pushItemTask);

        // Project to-dos with a due date, merged in live and read-only —
        // see the header comment in supabase-project-timeline-setup.sql.
        // Clicking one sends you to project-to-do.html rather than opening
        // the edit panel (see handleBarClick), since these aren't rows in
        // project_timeline_items and can't be edited from here.
        todoMarkers.forEach(sub => {
            if (!sub.due_date) return;
            const effectiveStatus = sub.completed ? "completed" : (sub.due_date < today ? "overdue" : "not_started");
            tasks.push({
                id: `todo-${sub.id}`,
                name: sub.label,
                start: sub.due_date,
                end: addDaysISO(sub.due_date, 1),
                progress: sub.completed ? 100 : 0,
                dependencies: "",
                custom_class: buildGanttCustomClass("milestone", effectiveStatus, true)
            });
        });

        return tasks;
    }

    /* ---------- Gantt rendering ---------- */

    // Week/Month/Quarter/Year are real date windows anchored on today, not
    // just a zoom/density change over the whole project:
    //   Week    — the Mon–Sun containing today
    //   Month   — the calendar month we're in
    //   Quarter — the calendar quarter we're in (Jan–Mar/Apr–Jun/Jul–Sep/
    //             Oct–Dec — quarters split into 4)
    //   Year    — the calendar year we're in
    // ganttMode is the underlying Frappe Gantt column granularity used to
    // render whichever window is selected — Frappe's own "Week"/"Month"
    // mean "one column per week/month across the whole chart", which isn't
    // what these buttons mean here, so button label and Frappe view mode
    // are deliberately different things.
    const PERIOD_GANTT_MODE = { Week: "Day", Month: "Day", Quarter: "Week", Year: "Month" };
    const GANTT_VIEW_MODES = ["Day", "Week", "Month"];

    function toISODateFromDate(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function getPeriodWindow(period) {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        let start, end;

        if (period === "Week") {
            const day = now.getDay(); // 0 = Sun ... 6 = Sat
            const mondayOffset = day === 0 ? -6 : 1 - day;
            start = new Date(now);
            start.setDate(now.getDate() + mondayOffset);
            end = new Date(start);
            end.setDate(start.getDate() + 6);
        } else if (period === "Quarter") {
            const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
            start = new Date(now.getFullYear(), quarterStartMonth, 1);
            end = new Date(now.getFullYear(), quarterStartMonth + 3, 0);
        } else if (period === "Year") {
            start = new Date(now.getFullYear(), 0, 1);
            end = new Date(now.getFullYear(), 11, 31);
        } else { // "Month"
            start = new Date(now.getFullYear(), now.getMonth(), 1);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        }

        return {
            start: toISODateFromDate(start),
            end: toISODateFromDate(end),
            ganttMode: PERIOD_GANTT_MODE[period] || "Day"
        };
    }

    // Narrows the full task list down to whatever overlaps [windowStart,
    // windowEnd], and adds one fully-invisible anchor task spanning the
    // entire window (see .gantt-item-anchor in styles.css) so the chart's
    // date bounds always match the selected period exactly — Week really
    // shows Mon–Sun, Month really shows the whole month — even when
    // nothing is scheduled right at the edges of it, or nothing is
    // scheduled in it at all.
    function windowTasks(allTasks, windowStart, windowEnd) {
        const visibleIds = new Set();
        const filtered = allTasks.filter(task => {
            const overlaps = task.end >= windowStart && task.start <= windowEnd;
            if (overlaps) visibleIds.add(task.id);
            return overlaps;
        });

        // Drop dependency arrows pointing at a task that got filtered out
        // of this window — nothing to draw an arrow to.
        filtered.forEach(task => {
            if (task.dependencies && !visibleIds.has(task.dependencies)) task.dependencies = "";
        });

        filtered.push({
            id: "__window_anchor",
            name: "",
            start: windowStart,
            end: addDaysISO(windowEnd, 1),
            progress: 0,
            dependencies: "",
            custom_class: "gantt-item-anchor"
        });

        return filtered;
    }

    function setActiveViewModeButton(name) {
        currentViewMode = name;
        document.querySelectorAll(".gantt-view-toggle-btn").forEach(btn => {
            btn.classList.toggle("is-active", btn.dataset.viewMode === name);
        });
    }

    function handleBarClick(task) {
        hideGanttHoverCard();
        if (task.id === "__window_anchor") return;
        if (typeof task.id === "string" && task.id.startsWith("todo-")) {
            if (currentProject) window.location.href = `project-to-do.html?id=${encodeURIComponent(currentProject.id)}`;
            return;
        }
        const item = timelineItems.find(i => String(i.id) === String(task.id));
        if (item) openEditPanel(item);
    }

    /* ---------- hover card (title/date/assignee) ----------
       Project to-do markers (-source-todo in styles.css) keep their title
       hidden on the bar itself — this card is the only place to see it.
       Everything else already shows its title on the bar; the card is just
       a quick-glance detail popup for those. Either way it's a small
       custom-built tooltip, not Frappe Gantt's own native popup
       (popup: false, set in initGantt), which is meant for click-to-edit
       and isn't what's wanted here. Frappe fully redraws every bar on each
       refresh()/change_view_mode() call, so attachBarHoverCards() has to be re-run
       after every render — old listeners just get garbage collected with
       the DOM nodes they were on. */

    function formatHoverDate(startDateStr, endDateStr) {
        const fmt = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        if (!startDateStr && !endDateStr) return "No dates set";
        if (!startDateStr || startDateStr === endDateStr) return fmt(endDateStr || startDateStr);
        return `${fmt(startDateStr)} – ${fmt(endDateStr)}`;
    }

    function hideGanttHoverCard() {
        document.getElementById("ganttHoverCard")?.classList.add("hidden");
    }

    function showGanttHoverCard(barEl, data) {
        const card = document.getElementById("ganttHoverCard");
        const titleEl = document.getElementById("ganttHoverCardTitle");
        const datesEl = document.getElementById("ganttHoverCardDates");
        const assigneeEl = document.getElementById("ganttHoverCardAssignee");
        if (!card || !titleEl || !datesEl || !assigneeEl) return;

        titleEl.textContent = data.title || "Untitled";
        datesEl.textContent = data.dates;
        assigneeEl.textContent = data.assignee;

        // Measure with the card already positioned off-screen-safe (still
        // "hidden" would give a 0-size rect) so width/height are real
        // before we place it — visibility:hidden keeps it out of the flash
        // of an incorrect position without affecting layout measurement.
        card.classList.remove("hidden");
        card.style.visibility = "hidden";
        const barRect = barEl.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();

        let left = barRect.left;
        let top = barRect.bottom + 8;
        if (left + cardRect.width > window.innerWidth - 12) left = window.innerWidth - cardRect.width - 12;
        if (left < 12) left = 12;
        if (top + cardRect.height > window.innerHeight - 12) top = barRect.top - cardRect.height - 8;

        card.style.left = `${Math.max(12, left)}px`;
        card.style.top = `${Math.max(12, top)}px`;
        card.style.visibility = "";
    }

    // Takes the exact same `tasks` array just handed to `new Gantt(...)`/
    // `.refresh()` and pairs it up with the rendered bar elements by
    // position rather than by reading a data-id (or similar) attribute off
    // the DOM — Frappe Gantt draws exactly one row per task, in the same
    // order they were passed in, so this is the one thing about its
    // internal markup we don't have to guess at or depend on staying the
    // same across versions. If the counts ever don't line up (a future
    // library update changing that assumption), skip hover cards for this
    // render rather than risk pairing a bar with the wrong task's info.
    function attachBarHoverCards(tasks) {
        hideGanttHoverCard();

        const wrappers = document.querySelectorAll("#ganttChart .bar-wrapper");
        if (wrappers.length !== tasks.length) {
            console.warn(`Gantt rendered ${wrappers.length} bars for ${tasks.length} tasks — skipping hover cards for this render.`);
            return;
        }

        wrappers.forEach((wrapper, i) => {
            const task = tasks[i];
            const taskId = task && task.id;
            if (!taskId || taskId === "__window_anchor") return;

            let data = null;

            if (taskId.startsWith("todo-")) {
                const sub = todoMarkers.find(s => String(s.id) === taskId.slice(5));
                if (sub) {
                    data = {
                        title: sub.label,
                        dates: formatHoverDate(null, sub.due_date),
                        assignee: sub.assigned_to_name || "Unassigned"
                    };
                }
            } else {
                const item = timelineItems.find(i => String(i.id) === taskId);
                if (item) {
                    let displayStart = item.start_date;
                    let displayEnd = item.end_date;
                    if (item.type === "phase") {
                        const effective = getPhaseEffectiveDates(item);
                        displayStart = effective.start;
                        displayEnd = effective.end;
                    } else if (item.type === "milestone") {
                        displayStart = null;
                        displayEnd = item.end_date;
                    }
                    data = {
                        title: item.title,
                        dates: formatHoverDate(displayStart, displayEnd),
                        assignee: item.assigned_to_name || "Unassigned"
                    };
                }
            }

            if (!data) return;

            wrapper.addEventListener("mouseenter", () => showGanttHoverCard(wrapper, data));
            wrapper.addEventListener("mouseleave", hideGanttHoverCard);
        });
    }

    function initGantt() {
        const container = document.getElementById("ganttChart");
        if (!container) return;

        const period = getPeriodWindow(currentViewMode);
        const tasks = windowTasks(buildGanttTasks(), period.start, period.end);

        // tasks always includes the invisible anchor, so "1 or fewer" means
        // nothing real is scheduled in this window.
        if (tasks.length <= 1) {
            // Discarding a live Gantt instance here (rather than trying to
            // reuse it once tasks reappear) is deliberate — Frappe Gantt
            // caches references to its own SVG/container elements when
            // constructed, so wiping container.innerHTML out from under a
            // live instance (as opposed to letting a *new* one take over
            // this now-empty div later) would leave it pointing at
            // detached DOM.
            container.innerHTML = `<p class="workbook-preview-loading">Nothing scheduled for this ${currentViewMode.toLowerCase()}.</p>`;
            gantt = null;
            hideGanttHoverCard();
            return;
        }

        if (gantt) {
            // An existing instance owns this container's contents —
            // .refresh() handles clearing/redrawing itself, so leave the
            // DOM alone here. change_view_mode still needs a separate call
            // since refresh() alone reuses whatever granularity was already
            // active, and switching periods can also mean switching
            // granularity (e.g. Quarter uses Frappe's "Week" columns).
            try {
                gantt.refresh(tasks);
                gantt.change_view_mode(period.ganttMode, false);
                attachBarHoverCards(tasks);
            } catch (err) {
                // If refresh()/change_view_mode() ever throws, fall through
                // to a full rebuild rather than leaving a stale/broken
                // chart on screen with no way to recover.
                console.error("Gantt refresh failed, rebuilding from scratch:", err);
                gantt = null;
                initGantt();
            }
            return;
        }

        // First render, or recovering from the "nothing scheduled" state
        // above — clear out any leftover message before construction.
        container.innerHTML = "";

        try {
            gantt = new Gantt(container, tasks, {
                view_mode: period.ganttMode,
                view_modes: GANTT_VIEW_MODES,
                view_mode_select: false,
                today_button: true,
                bar_height: 24,
                padding: 16,
                // Bounded rather than "auto" so a project with hundreds of
                // rows scrolls internally within a fixed, comfortable height
                // instead of stretching the whole page.
                container_height: 560,
                // infinite_padding (Frappe's default) live-extends the date
                // range as you scroll near either edge, re-rendering on the
                // fly — glitchy, and pointless here since windowTasks()
                // above already pins the exact date range we want via the
                // anchor task.
                infinite_padding: false,
                // Editing happens through the side panel, not by dragging
                // bars on the chart — see this file's header comment.
                readonly: true,
                popup: false,
                on_click: handleBarClick
                // No on_view_change here — the toolbar's active button is
                // driven by setActiveViewModeButton() directly (see the
                // click handler below), not by Frappe's own view-mode
                // events, since a period button and a Frappe granularity
                // are no longer the same thing (Quarter uses Frappe's
                // "Week" mode, so on_view_change("Week") would wrongly
                // highlight the Week button while Quarter was selected).
            });
            attachBarHoverCards(tasks);
        } catch (err) {
            // A failed construction used to fail silently — gantt stayed
            // null, the container was left blank, and the Week/Month/
            // Quarter/Year buttons would toggle their own highlight
            // (setActiveViewModeButton) but have nothing to actually show,
            // which looks exactly like "the buttons don't work" with no
            // indication why. Surface it instead.
            console.error("Failed to build the Gantt chart:", err);
            gantt = null;
            container.innerHTML = '<p class="workbook-preview-loading">Couldn\'t load the timeline chart. Try refreshing the page — if this keeps happening, note what you were doing and let support know.</p>';
            setTimelinePageMessage("The timeline chart failed to load. Try refreshing the page.", "error");
        }
    }

    function renderEverything() {
        computeAndRenderStats();
        initGantt();
    }

    /* ---------- side panel ---------- */

    function populateParentOptions(selectedId, excludeId) {
        const select = document.getElementById("timelineParentInput");
        if (!select) return;
        const options = [`<option value="">No phase — top level</option>`];
        timelineItems
            .filter(i => i.type === "phase" && String(i.id) !== String(excludeId))
            .forEach(phase => {
                const selected = String(phase.id) === String(selectedId) ? "selected" : "";
                options.push(`<option value="${phase.id}" ${selected}>${escapeHtmlTimeline(phase.title)}</option>`);
            });
        select.innerHTML = options.join("");
    }

    function populateDependsOnOptions(selectedId, excludeId) {
        const select = document.getElementById("timelineDependsOnInput");
        if (!select) return;
        const options = [`<option value="">None</option>`];
        timelineItems
            .filter(i => String(i.id) !== String(excludeId))
            .forEach(item => {
                const selected = String(item.id) === String(selectedId) ? "selected" : "";
                options.push(`<option value="${item.id}" ${selected}>${escapeHtmlTimeline(item.title)}</option>`);
            });
        select.innerHTML = options.join("");
    }

    // Shows/hides and toggles `required` on form fields based on item type:
    // milestones only need a single date (no progress bar, no phase
    // nesting); phases can leave dates blank (auto-computed from children,
    // see getPhaseEffectiveDates) and can't nest under another phase.
    function syncFormFieldsForType(type) {
        document.querySelectorAll(".timeline-type-toggle-btn").forEach(btn => {
            btn.classList.toggle("is-active", btn.dataset.type === type);
        });

        const isMilestone = type === "milestone";
        const isPhase = type === "phase";

        const startInput = document.getElementById("timelineStartDateInput");
        const endInput = document.getElementById("timelineEndDateInput");
        const startWrap = startInput.closest(".auth-field");
        const endLabelText = document.getElementById("timelineEndDateLabelText");
        const progressField = document.getElementById("timelineProgressField");
        const parentField = document.getElementById("timelineParentField");

        startWrap.style.display = isMilestone ? "none" : "";
        endLabelText.textContent = isMilestone ? "Date" : "End date";
        progressField.style.display = isMilestone ? "none" : "";
        parentField.style.display = isPhase ? "none" : "";

        startInput.required = !isMilestone && !isPhase;
        endInput.required = !isPhase;
    }

    function showTimelinePanel() {
        const panel = document.getElementById("timelinePanel");
        if (!panel) return;
        panel.classList.remove("hidden");
        void panel.offsetWidth; // force layout so the slide-in transition actually runs
        panel.classList.add("is-open");
        document.body.classList.add("todo-panel-open"); // reuses the same "push .main-content over" hook as project-to-do.html
    }

    function closeTimelinePanel() {
        const panel = document.getElementById("timelinePanel");
        if (!panel || !panel.classList.contains("is-open")) return;
        panel.classList.remove("is-open");
        document.body.classList.remove("todo-panel-open");
        editingItemId = null;
        setTimeout(() => { panel.classList.add("hidden"); }, 250);
    }

    function openCreatePanel(prefillType) {
        editingItemId = null;
        document.getElementById("timelinePanelTitle").textContent = "New item";
        document.getElementById("deleteTimelineItemBtn").style.display = "none";
        document.getElementById("timelineItemForm").reset();
        document.getElementById("timelineItemIdInput").value = "";
        document.getElementById("timelineProgressRange").value = 0;
        document.getElementById("timelineProgressValue").textContent = "0%";
        setTimelinePanelMessage("");
        populateAssigneeOptionsInto(null);
        populateParentOptions(null, null);
        populateDependsOnOptions(null, null);
        syncFormFieldsForType(prefillType || "task");
        showTimelinePanel();
        document.getElementById("timelineTitleInput")?.focus();
    }

    function openEditPanel(item) {
        editingItemId = item.id;
        document.getElementById("timelinePanelTitle").textContent = "Edit item";
        document.getElementById("deleteTimelineItemBtn").style.display = "";
        document.getElementById("timelineItemIdInput").value = item.id;
        document.getElementById("timelineTitleInput").value = item.title || "";
        document.getElementById("timelineDescriptionInput").value = item.description || "";
        document.getElementById("timelineStartDateInput").value = item.start_date || "";
        document.getElementById("timelineEndDateInput").value = item.end_date || "";
        document.getElementById("timelineStatusInput").value = item.status || "not_started";
        const progress = item.progress || 0;
        document.getElementById("timelineProgressRange").value = progress;
        document.getElementById("timelineProgressValue").textContent = `${progress}%`;
        setTimelinePanelMessage("");
        populateAssigneeOptionsInto(item.assigned_to);
        populateParentOptions(item.parent_id, item.id);
        populateDependsOnOptions(item.depends_on_id, item.id);
        syncFormFieldsForType(item.type || "task");
        showTimelinePanel();
    }

    function populateAssigneeOptionsInto(selectedId) {
        const select = document.getElementById("timelineAssigneeInput");
        if (select) select.innerHTML = assigneeOptionsHtml(selectedId);
    }

    async function saveTimelineItem(event) {
        event.preventDefault();
        if (!currentProject) return;

        const type = document.querySelector(".timeline-type-toggle-btn.is-active")?.dataset.type || "task";
        const title = document.getElementById("timelineTitleInput").value.trim();
        const description = document.getElementById("timelineDescriptionInput").value.trim();
        const startDate = document.getElementById("timelineStartDateInput").value || null;
        const endDate = document.getElementById("timelineEndDateInput").value || null;
        const status = document.getElementById("timelineStatusInput").value;
        const progress = type === "milestone"
            ? (status === "completed" ? 100 : 0)
            : (parseInt(document.getElementById("timelineProgressRange").value, 10) || 0);
        const assigneeId = document.getElementById("timelineAssigneeInput").value || null;
        const assigneeName = assigneeId ? staffNameById(assigneeId) : null;
        const dependsOnId = document.getElementById("timelineDependsOnInput").value || null;
        const parentId = type === "phase" ? null : (document.getElementById("timelineParentInput").value || null);

        if (!title) {
            setTimelinePanelMessage("Give it a title first.", "error");
            document.getElementById("timelineTitleInput")?.focus();
            return;
        }
        if (type === "milestone" && !endDate) {
            setTimelinePanelMessage("Set a date for this milestone.", "error");
            return;
        }
        if (type === "task" && (!startDate || !endDate)) {
            setTimelinePanelMessage("Set both a start and end date.", "error");
            return;
        }
        if (startDate && endDate && startDate > endDate) {
            setTimelinePanelMessage("Start date is after the end date.", "error");
            return;
        }

        const payload = {
            project_id: currentProject.id,
            type,
            title,
            description: description || null,
            start_date: type === "milestone" ? null : startDate,
            end_date: endDate,
            status,
            progress,
            assigned_to: assigneeId,
            assigned_to_name: assigneeName,
            depends_on_id: dependsOnId,
            parent_id: parentId
        };

        const saveBtn = document.getElementById("saveTimelineItemBtn");
        if (saveBtn) saveBtn.disabled = true;

        let error, savedRow;
        if (editingItemId) {
            ({ error } = await window.supabaseClient.from(TIMELINE_TABLE).update(payload).eq("id", editingItemId));
        } else {
            payload.position = timelineItems.length;
            payload.created_by_id = getTimelineStaffId();
            payload.created_by_name = getTimelineStaffName();
            const inserted = await window.supabaseClient.from(TIMELINE_TABLE).insert(payload).select().single();
            error = inserted.error;
            savedRow = inserted.data;
        }

        if (saveBtn) saveBtn.disabled = false;

        if (error) {
            console.error("Failed to save timeline item:", error);
            setTimelinePanelMessage("Couldn't save that. Please try again.", "error");
            return;
        }

        if (editingItemId) {
            const idx = timelineItems.findIndex(i => String(i.id) === String(editingItemId));
            if (idx !== -1) timelineItems[idx] = { ...timelineItems[idx], ...payload };
        } else if (savedRow) {
            timelineItems.push(savedRow);
        }

        closeTimelinePanel();

        const bodyEl = document.getElementById("timelineBody");
        const emptyEl = document.getElementById("timelineEmptyState");
        if (bodyEl && bodyEl.style.display === "none") {
            bodyEl.style.display = "block";
            if (emptyEl) emptyEl.style.display = "none";
        }

        renderEverything();
    }

    /* ---------- delete ---------- */

    function openDeleteConfirm() {
        if (!editingItemId) return;
        pendingDeleteId = editingItemId;
        const messageEl = document.getElementById("deleteTimelineItemConfirmMessage");
        if (messageEl) messageEl.textContent = "";
        document.getElementById("deleteTimelineItemConfirmOverlay")?.classList.remove("hidden");
    }

    function closeDeleteConfirm() {
        document.getElementById("deleteTimelineItemConfirmOverlay")?.classList.add("hidden");
        pendingDeleteId = null;
    }

    async function confirmDeleteTimelineItem() {
        if (!pendingDeleteId) return;
        const id = pendingDeleteId;
        const confirmBtn = document.getElementById("confirmDeleteTimelineItemBtn");
        const messageEl = document.getElementById("deleteTimelineItemConfirmMessage");
        if (confirmBtn) confirmBtn.disabled = true;

        const { error } = await window.supabaseClient.from(TIMELINE_TABLE).delete().eq("id", id);

        if (confirmBtn) confirmBtn.disabled = false;

        if (error) {
            console.error("Failed to delete timeline item:", error);
            if (messageEl) messageEl.textContent = "Something went wrong deleting this item. Please try again.";
            return;
        }

        // The database cascades child rows (parent_id references ... on
        // delete cascade) — mirror that locally so the chart updates
        // immediately without a re-fetch.
        timelineItems = timelineItems.filter(i => String(i.id) !== String(id) && String(i.parent_id) !== String(id));

        closeDeleteConfirm();
        closeTimelinePanel();

        if (timelineItems.length === 0 && todoMarkers.length === 0) {
            document.getElementById("timelineBody").style.display = "none";
            document.getElementById("timelineEmptyState").style.display = "block";
        } else {
            renderEverything();
        }

        setTimelinePageMessage("Item deleted.", "success");
    }

    /* ---------- init ---------- */

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;
        currentProject = project;

        const heroNameEl = document.getElementById("timelineHeroName");
        const addButtons = [
            document.getElementById("addPhaseBtn"),
            document.getElementById("addTaskBtn"),
            document.getElementById("addMilestoneBtn")
        ];

        if (error || !project) {
            setTimelinePageMessage("No project selected. Pick one from Project Overview.", "error");
            document.getElementById("timelineLoadingState").style.display = "none";
            addButtons.forEach(btn => { if (btn) btn.disabled = true; });
            return;
        }

        if (heroNameEl) heroNameEl.textContent = `Project Timeline — ${project.name || "Untitled project"}`;

        await loadStaffDirectory();
        await loadTimelineData(project.id);

        // Sidebar search (project-shell.js) links Timeline results here as
        // ?openItem=<id> — jump straight to that item's edit panel rather
        // than making the user find it on the chart themselves, which
        // might not even be showing right now (the item's dates might fall
        // outside whatever Week/Month/Quarter/Year window is selected).
        const openItemId = new URLSearchParams(window.location.search).get("openItem");
        if (openItemId) {
            const item = timelineItems.find(i => String(i.id) === openItemId);
            if (item) openEditPanel(item);
        }
    });

    document.addEventListener("DOMContentLoaded", () => {
        document.getElementById("addPhaseBtn")?.addEventListener("click", () => openCreatePanel("phase"));
        document.getElementById("addTaskBtn")?.addEventListener("click", () => openCreatePanel("task"));
        document.getElementById("addMilestoneBtn")?.addEventListener("click", () => openCreatePanel("milestone"));

        document.querySelectorAll(".timeline-type-toggle-btn").forEach(btn => {
            btn.addEventListener("click", () => syncFormFieldsForType(btn.dataset.type));
        });

        document.getElementById("timelineProgressRange")?.addEventListener("input", (e) => {
            const valueEl = document.getElementById("timelineProgressValue");
            if (valueEl) valueEl.textContent = `${e.target.value}%`;
        });

        document.getElementById("timelineItemForm")?.addEventListener("submit", saveTimelineItem);
        document.getElementById("cancelTimelineItemBtn")?.addEventListener("click", closeTimelinePanel);
        document.getElementById("closeTimelinePanelBtn")?.addEventListener("click", closeTimelinePanel);
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") closeTimelinePanel();
        });

        document.getElementById("deleteTimelineItemBtn")?.addEventListener("click", openDeleteConfirm);
        document.getElementById("cancelDeleteTimelineItemBtn")?.addEventListener("click", closeDeleteConfirm);
        document.getElementById("confirmDeleteTimelineItemBtn")?.addEventListener("click", confirmDeleteTimelineItem);
        document.getElementById("deleteTimelineItemConfirmOverlay")?.addEventListener("click", (e) => {
            if (e.target === e.currentTarget) closeDeleteConfirm();
        });

        document.querySelectorAll(".gantt-view-toggle-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const period = btn.dataset.viewMode; // "Week" | "Month" | "Quarter" | "Year"
                // Update the pill highlight immediately, then rebuild the
                // chart for the newly selected window — switching periods
                // usually also means switching the underlying Frappe
                // granularity (see PERIOD_GANTT_MODE), and swaps the actual
                // task set (windowTasks), so this needs a full initGantt()
                // pass rather than just gantt.change_view_mode().
                setActiveViewModeButton(period);
                try {
                    initGantt();
                } catch (err) {
                    console.error(`Failed to switch the timeline to "${period}" view:`, err);
                    setTimelinePageMessage("Couldn't switch the timeline view. Try refreshing the page.", "error");
                }
            });
        });
    });
})();
