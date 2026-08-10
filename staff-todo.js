/* ===========================================================
   STAFF TO-DO (staff-to-do.html)

   Two sections:
   - My Tasks: the signed-in staff member's own personal tasks (same
     public.tasks table and Notion-style row/add pattern as the dashboard's
     My Tasks card — see dashboard scripts/task.js, which this mirrors).
   - Project To-Do: every still-open project_todo_subitems row assigned to
     them, across every project, shown as:

       PROJECT NAME
       <checklist item text>   (with the big item's title as a small caption)

     Checking one off here updates the same row project-to-do.html reads,
     and it drops out of this list once completed.
=========================================================== */

(function () {
    "use strict";

    const TASKS_TABLE = "tasks";
    const TODO_SUBITEMS_TABLE = "project_todo_subitems";
    const TODO_ITEMS_TABLE = "project_todo_items";
    const PROJECTS_TABLE = "projects";
    const MAX_MY_TASKS = 25;

    function escapeHtmlStaffTodo(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function getStaffTodoProfile() {
        return window.currentSupabaseProfile
            || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    }

    function getStaffTodoId(profile) {
        return profile?.id || profile?.uid || null;
    }

    // Same "Due today / Due tomorrow / Overdue" formatting as
    // DashboardShared.formatDueLabel (dashboard scripts/dashboard.js) —
    // duplicated locally since this page doesn't load that script.
    function formatDueLabel(dueDateStr) {
        if (!dueDateStr) return { text: "No due date", cls: "" };

        const due = new Date(dueDateStr + "T00:00:00");
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const diffDays = Math.round((due - today) / 86400000);

        if (diffDays < 0) return { text: "Overdue", cls: "due-overdue" };
        if (diffDays === 0) return { text: "Due today", cls: "due-today" };
        if (diffDays === 1) return { text: "Due tomorrow", cls: "due-tomorrow" };
        return {
            text: due.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            cls: "due-upcoming",
        };
    }

    // Overdue/today/tomorrow get the colored row accent + pill (Option B);
    // everything else is plain muted text.
    const MY_TASKS_DUE_TIERS = { "due-overdue": "overdue", "due-today": "today", "due-tomorrow": "tomorrow" };

    /* ---------- My Tasks ---------- */

    async function loadMyTasks() {
        const listEl = document.getElementById("myTasksList");
        const subtitleEl = document.getElementById("myTasksCountSubtitle");
        const addInput = document.getElementById("newTaskInlineInput");
        if (!listEl) return;

        const profile = getStaffTodoProfile();
        const staffId = getStaffTodoId(profile);

        if (!staffId) {
            listEl.innerHTML = '<p class="card-subtitle">Sign in to see your tasks.</p>';
            if (addInput) addInput.disabled = true;
            return;
        }

        if (!window.supabaseClient) {
            listEl.innerHTML = '<p class="card-subtitle">Couldn\'t connect. Please refresh the page.</p>';
            return;
        }

        const { data, error } = await window.supabaseClient
            .from(TASKS_TABLE)
            .select("id, task_name, due_date, completed")
            .eq("user_id", staffId)
            .eq("completed", false)
            .order("due_date", { ascending: true, nullsFirst: false })
            .limit(MAX_MY_TASKS);

        if (error) {
            console.error("Failed to load tasks:", error);
            listEl.innerHTML = '<p class="card-subtitle">Couldn\'t load your tasks right now.</p>';
            return;
        }

        const tasks = data || [];
        if (subtitleEl) subtitleEl.textContent = tasks.length ? `${tasks.length} open task${tasks.length === 1 ? "" : "s"}` : "";

        if (tasks.length === 0) {
            listEl.innerHTML = '<p class="card-subtitle">No open tasks — nice work.</p>';
            return;
        }

        listEl.innerHTML = tasks.map(task => {
            const due = formatDueLabel(task.due_date);
            const tier = MY_TASKS_DUE_TIERS[due.cls];
            const dueHtml = tier
                ? `<span class="mytask-due-pill mytask-due-pill--${tier}">${escapeHtmlStaffTodo(due.text)}</span>`
                : `<span class="mytask-due-plain">${escapeHtmlStaffTodo(due.text)}</span>`;

            return `
                <div class="mytask-row ${tier ? `mytask-row--${tier}` : ""}" data-task-id="${task.id}">
                    <input type="checkbox" class="todo-item-checkbox" data-action="complete-task" aria-label="Mark '${escapeHtmlStaffTodo(task.task_name)}' complete">
                    <span class="mytask-row-title">${escapeHtmlStaffTodo(task.task_name)}</span>
                    ${dueHtml}
                </div>
            `;
        }).join("");

        listEl.querySelectorAll('[data-action="complete-task"]').forEach(checkbox => {
            checkbox.addEventListener("change", () => completeTask(checkbox.closest(".mytask-row").dataset.taskId));
        });
    }

    async function completeTask(taskId) {
        const { error } = await window.supabaseClient
            .from(TASKS_TABLE)
            .update({ completed: true })
            .eq("id", taskId);

        if (error) {
            console.error("Failed to complete task:", error);
            return;
        }
        loadMyTasks();
    }

    async function createTaskInline() {
        const input = document.getElementById("newTaskInlineInput");
        const dueDateInput = document.getElementById("newTaskDueDateInput");
        const taskName = input?.value.trim();
        if (!taskName) return;

        const profile = getStaffTodoProfile();
        const staffId = getStaffTodoId(profile);
        if (!staffId) return;

        if (input) input.disabled = true;

        const { error } = await window.supabaseClient.from(TASKS_TABLE).insert({
            user_id: staffId,
            task_name: taskName,
            due_date: dueDateInput?.value || null,
            description: null,
            completed: false
        });

        if (input) input.disabled = false;

        if (error) {
            console.error("Failed to create task:", error);
            return;
        }

        if (input) { input.value = ""; input.focus(); }
        if (dueDateInput) dueDateInput.value = "";
        loadMyTasks();
    }

    async function loadProjectTodo() {
        const listEl = document.getElementById("projectTodoList");
        const subtitleEl = document.getElementById("projectTodoCountSubtitle");
        if (!listEl) return;

        const profile = getStaffTodoProfile();
        const staffId = getStaffTodoId(profile);

        if (!staffId) {
            listEl.innerHTML = '<p class="card-subtitle">Sign in to see what\'s assigned to you.</p>';
            return;
        }

        if (!window.supabaseClient) {
            listEl.innerHTML = '<p class="card-subtitle">Couldn\'t connect. Please refresh the page.</p>';
            return;
        }

        const { data: subitems, error } = await window.supabaseClient
            .from(TODO_SUBITEMS_TABLE)
            .select("id, label, project_id, todo_item_id, created_at")
            .eq("assigned_to", staffId)
            .eq("completed", false)
            .order("created_at", { ascending: true });

        if (error) {
            console.error("Failed to load assigned project to-do items:", error);
            listEl.innerHTML = '<p class="card-subtitle">Couldn\'t load your project to-do items right now.</p>';
            return;
        }

        if (!subitems || subitems.length === 0) {
            if (subtitleEl) subtitleEl.textContent = "Nothing assigned to you right now.";
            listEl.innerHTML = '<p class="card-subtitle">Nothing here — you\'re all caught up.</p>';
            return;
        }

        // Look up the parent big-item titles and project names in bulk
        // (small, separate queries rather than relying on PostgREST embed
        // syntax — keeps this simple and easy to follow).
        const todoItemIds = [...new Set(subitems.map(s => s.todo_item_id))];
        const projectIds = [...new Set(subitems.map(s => s.project_id))];

        const [itemsResult, projectsResult] = await Promise.all([
            window.supabaseClient.from(TODO_ITEMS_TABLE).select("id, title").in("id", todoItemIds),
            window.supabaseClient.from(PROJECTS_TABLE).select("id, name").in("id", projectIds)
        ]);

        const itemTitleById = {};
        (itemsResult.data || []).forEach(i => { itemTitleById[i.id] = i.title; });

        const projectNameById = {};
        (projectsResult.data || []).forEach(p => { projectNameById[p.id] = p.name || "Untitled project"; });

        if (subtitleEl) subtitleEl.textContent = `${subitems.length} open item${subitems.length === 1 ? "" : "s"}`;

        listEl.innerHTML = subitems.map(sub => `
            <div class="info-item project-todo-item">
                <div class="project-todo-item__left">
                    <button type="button" class="task-check" data-subitem-id="${sub.id}" aria-label="Mark complete"></button>
                    <div>
                        <span class="project-todo-item__project">${escapeHtmlStaffTodo(projectNameById[sub.project_id] || "Untitled project")}</span>
                        <h3>${escapeHtmlStaffTodo(sub.label)}</h3>
                        <p>${escapeHtmlStaffTodo(itemTitleById[sub.todo_item_id] || "")}</p>
                    </div>
                </div>
                <a class="workbook-btn workbook-btn--preview" href="project-to-do.html?id=${encodeURIComponent(sub.project_id)}">Open</a>
            </div>
        `).join("");

        listEl.querySelectorAll(".task-check").forEach(btn => {
            btn.addEventListener("click", async () => {
                btn.disabled = true;
                const { error: updateError } = await window.supabaseClient
                    .from(TODO_SUBITEMS_TABLE)
                    .update({ completed: true })
                    .eq("id", btn.dataset.subitemId);

                if (updateError) {
                    console.error("Failed to complete item:", updateError);
                    btn.disabled = false;
                    return;
                }
                loadProjectTodo();
            });
        });
    }

    document.addEventListener("DOMContentLoaded", () => {
        loadMyTasks();
        loadProjectTodo();

        document.getElementById("newTaskInlineInput")?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); createTaskInline(); }
        });
    });
})();
