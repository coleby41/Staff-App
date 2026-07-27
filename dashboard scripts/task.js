/* ============================================================================
   tasks-card.js — "My Tasks" dashboard card
   Requires: dashboard-shared.js loaded first, window.supabaseClient ready,
   and the following markup present in dashboard.html:

     <div class="card">
       <div class="card-header">
         <h2 class="card-title">My Tasks</h2>
         <a href="tasks.html" class="chip">View all</a>
       </div>
       <div id="myTasksList" class="info-list"></div>
       <a href="#" id="addTaskLink" class="auth-link">+ Add new task</a>
     </div>

   Table: public.tasks (user_id, task_name, due_date, description, completed)
============================================================================ */

(function () {
  "use strict";

  const DS = window.DashboardShared;
  const MAX_DASHBOARD_TASKS = 4;

  let currentProfile = null;

  document.addEventListener("DOMContentLoaded", async () => {
    const listEl = document.getElementById("myTasksList");
    const addLink = document.getElementById("addTaskLink");
    if (!listEl) return; // card not on this page

    currentProfile = await DS.getStaffProfile();
    if (!currentProfile) {
      listEl.innerHTML = `<p class="card-subtitle">Sign in to see your tasks.</p>`;
      return;
    }

    await loadTasks();

    if (addLink) {
      addLink.addEventListener("click", (e) => {
        e.preventDefault();
        openAddTaskModal();
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

  function renderTasks(tasks) {
    const listEl = document.getElementById("myTasksList");

    if (tasks.length === 0) {
      listEl.innerHTML = `<p class="card-subtitle">No open tasks — nice work.</p>`;
      return;
    }

    listEl.innerHTML = tasks
      .map((task) => {
        const due = DS.formatDueLabel(task.due_date);
        return `
          <div class="info-item task-item" data-task-id="${task.id}">
            <div class="task-item__left">
              <button
                type="button"
                class="task-check"
                aria-label="Mark '${DS.escapeHtml(task.task_name)}' complete"
                data-task-id="${task.id}"
              ></button>
              <span class="task-name">${DS.escapeHtml(task.task_name)}</span>
            </div>
            <span class="task-due ${due.cls}">${due.text}</span>
          </div>
        `;
      })
      .join("");

    listEl.querySelectorAll(".task-check").forEach((btn) => {
      btn.addEventListener("click", () => completeTask(btn.dataset.taskId));
    });
  }

  async function completeTask(taskId) {
    const { error } = await DS.safeQuery(
      "complete task",
      window.supabaseClient.from("tasks").update({ completed: true }).eq("id", taskId)
    );
    if (!error) loadTasks();
  }

  function openAddTaskModal() {
    const overlay = DS.buildPopup(
      "addTaskModal",
      `
      <h2>Add new task</h2>
      <form id="addTaskForm" class="auth-form">
        <label class="auth-field">
          Task name
          <input type="text" id="taskNameInput" required maxlength="120" placeholder="e.g. Submit weekly time sheet" />
        </label>
        <label class="auth-field">
          Due date
          <input type="date" id="taskDueDateInput" />
        </label>
        <label class="auth-field">
          Description
          <textarea id="taskDescriptionInput" placeholder="Optional details"></textarea>
        </label>
        <p id="addTaskMessage" class="auth-message"></p>
        <div class="popup-buttons">
          <button type="button" class="auth-button auth-button--secondary" id="cancelAddTaskBtn">Cancel</button>
          <button type="submit" class="auth-button">Add task</button>
        </div>
      </form>
      `
    );

    DS.openPopup(overlay);

    overlay.querySelector("#cancelAddTaskBtn").addEventListener("click", () => DS.closePopup(overlay));

    overlay.querySelector("#addTaskForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const messageEl = overlay.querySelector("#addTaskMessage");
      const taskName = overlay.querySelector("#taskNameInput").value.trim();
      const dueDate = overlay.querySelector("#taskDueDateInput").value || null;
      const description = overlay.querySelector("#taskDescriptionInput").value.trim() || null;

      if (!taskName) {
        DS.setFormMessage(messageEl, "Task name is required.", "error");
        return;
      }

      const { error } = await DS.safeQuery(
        "create task",
        window.supabaseClient.from("tasks").insert({
          user_id: DS.getUserId(currentProfile),
          task_name: taskName,
          due_date: dueDate,
          description,
          completed: false,
        })
      );

      if (error) {
        DS.setFormMessage(messageEl, "Couldn't add task. Try again.", "error");
        return;
      }

      DS.closePopup(overlay);
      loadTasks();
    });
  }
})();