/* ============================================================================
   tasks-card.js — "My Tasks" dashboard card
   Requires: dashboard-shared.js loaded first, window.supabaseClient ready,
   and the following markup present in dashboard.html:

     <div class="card">
       <div class="card-header">
         <h2 class="card-title">My Tasks</h2>
         <a href="/pages/staff-todo.html" class="chip">View all</a>
       </div>
       <div id="myTasksList" class="mytask-list"></div>
       <div class="todo-item-row todo-item-add-row">
         <span class="todo-item-add-icon">+</span>
         <input type="text" id="newTaskInlineInput" class="todo-item-add-input" placeholder="New task">
         <input type="date" id="newTaskDueDateInput" class="todo-item-add-date" aria-label="Due date">
       </div>
     </div>

   Card rows with a colored left-edge accent + due-date pill for anything
   overdue/today/tomorrow (plain muted date otherwise), and an inline
   "+ New task" row instead of a popup modal for adding one.

   Table: public.tasks (user_id, task_name, due_date, description, completed)
============================================================================ */

(function () {
  "use strict";

  const DS = window.DashboardShared;
  const MAX_DASHBOARD_TASKS = 4;

  let currentProfile = null;

  document.addEventListener("DOMContentLoaded", async () => {
    const listEl = document.getElementById("myTasksList");
    const addInput = document.getElementById("newTaskInlineInput");
    const dueDateInput = document.getElementById("newTaskDueDateInput");
    if (!listEl) return; // card not on this page

    currentProfile = await DS.getStaffProfile();
    if (!currentProfile) {
      listEl.innerHTML = `<p class="card-subtitle">Sign in to see your tasks.</p>`;
      if (addInput) addInput.disabled = true;
      return;
    }

    await loadTasks();

    if (addInput) {
      addInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); createTaskInline(addInput, dueDateInput); }
      });
    }
  });

  async function loadTasks() {
    const listEl = document.getElementById("myTasksList");
    const userId = DS.getUserId(currentProfile);

    const { data, error } = await DS.safeQuery(
      "load tasks",
      window.supabaseClient
        .from("tasks")
        .select("id, task_name, due_date, description, completed")
        .eq("user_id", userId)
        .eq("completed", false)
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(MAX_DASHBOARD_TASKS)
    );

    if (error) {
      listEl.innerHTML = `<p class="card-subtitle">Couldn't load tasks right now.</p>`;
      return;
    }

    renderTasks(data || []);
  }

  // due.cls (from DS.formatDueLabel) is one of: "due-overdue", "due-today",
  // "due-tomorrow", "due-upcoming", or "" (no due date). Overdue/today/
  // tomorrow get the colored row accent + pill; everything else is plain
  // muted text, matching Option B from the mockups.
  const DUE_TIERS = { "due-overdue": "overdue", "due-today": "today", "due-tomorrow": "tomorrow" };

  function renderTasks(tasks) {
    const listEl = document.getElementById("myTasksList");

    if (tasks.length === 0) {
      listEl.innerHTML = `<p class="card-subtitle">No open tasks — nice work.</p>`;
      return;
    }

    listEl.innerHTML = tasks
      .map((task) => {
        const due = DS.formatDueLabel(task.due_date);
        const tier = DUE_TIERS[due.cls];
        const dueHtml = tier
          ? `<span class="mytask-due-pill mytask-due-pill--${tier}">${due.text}</span>`
          : `<span class="mytask-due-plain">${due.text}</span>`;

        return `
          <div class="mytask-row ${tier ? `mytask-row--${tier}` : ""}" data-task-id="${task.id}">
            <input type="checkbox" class="todo-item-checkbox" data-action="complete" aria-label="Mark '${DS.escapeHtml(task.task_name)}' complete">
            <span class="mytask-row-title">${DS.escapeHtml(task.task_name)}</span>
            ${dueHtml}
          </div>
        `;
      })
      .join("");

    listEl.querySelectorAll('[data-action="complete"]').forEach((checkbox) => {
      checkbox.addEventListener("change", () => completeTask(checkbox.closest(".mytask-row").dataset.taskId));
    });
  }

  async function completeTask(taskId) {
    const { error } = await DS.safeQuery(
      "complete task",
      window.supabaseClient.from("tasks").update({ completed: true }).eq("id", taskId)
    );
    if (!error) loadTasks();
  }

  async function createTaskInline(input, dueDateInput) {
    const taskName = input.value.trim();
    if (!taskName) return;

    input.disabled = true;

    const { error } = await DS.safeQuery(
      "create task",
      window.supabaseClient.from("tasks").insert({
        user_id: DS.getUserId(currentProfile),
        task_name: taskName,
        due_date: dueDateInput?.value || null,
        description: null,
        completed: false,
      })
    );

    input.disabled = false;

    if (error) return;

    input.value = "";
    if (dueDateInput) dueDateInput.value = "";
    input.focus();
    loadTasks();
  }
})();
