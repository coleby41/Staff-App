/* ===========================================================
   PROJECT TO-DO (project-to-do.html)

   Notion-style checklist for a single project: a flat list of "big items"
   (checkbox + title, own completed state) — click a title to open a side
   panel with that item as the header and its checklist underneath. Every
   checklist row can be assigned to a staff member and checked off
   independently of the big item's own checkbox. New items are added via
   the "+ New task" row at the bottom of the list (type + Enter).

   Waits for the "project-shell:ready" event (project-shell.js) to know
   which project we're on, then owns everything below the header/sidebar.

   Tables: project_todo_items (big items, has its own `completed`),
   project_todo_subitems (checklist rows, each with assigned_to /
   assigned_to_name and its own `completed`).
=========================================================== */

(function () {
    "use strict";

    const TODO_ITEMS_TABLE = "project_todo_items";
    const TODO_SUBITEMS_TABLE = "project_todo_subitems";

    let currentProject = null;
    let todoItems = [];              // project_todo_items rows for this project
    let subitemsByItemId = {};       // { [todo_item_id]: subitem[] }
    let staffDirectory = [];         // [{ id, full_name }] — active staff, for assignee pickers
    let openPanelItem = null;        // the todo item currently shown in the side panel

    /* ---------- helpers ---------- */

    function escapeHtmlTodo(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function getTodoStaffProfile() {
        return window.currentSupabaseProfile
            || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    }

    function getTodoStaffName() {
        const profile = getTodoStaffProfile();
        return (profile && (profile.full_name || profile.username)) || "Staff";
    }

    function getTodoStaffId() {
        const profile = getTodoStaffProfile();
        return profile?.id || profile?.uid || null;
    }

    function setTodoPageMessage(text, type) {
        const el = document.getElementById("todoPageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; return; }
        el.textContent = text;
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = "block";
        if (type === "success") setTimeout(() => { el.style.display = "none"; }, 4000);
    }

    function setTodoPanelMessage(text, type) {
        const el = document.getElementById("todoPanelMessage");
        if (!el) return;
        el.textContent = text || "";
        el.className = `auth-message ${type || ""}`.trim();
    }

    /* ---------- staff directory (assignee pickers) ---------- */

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

    function assigneeSelectOptionsHtml(selectedId) {
        const options = [`<option value="">Unassigned</option>`];
        staffDirectory.forEach(person => {
            const selected = String(person.id) === String(selectedId) ? "selected" : "";
            options.push(`<option value="${person.id}" ${selected}>${escapeHtmlTodo(person.full_name || "Staff")}</option>`);
        });
        return options.join("");
    }

    function staffNameById(id) {
        const match = staffDirectory.find(p => String(p.id) === String(id));
        return match ? (match.full_name || "Staff") : null;
    }

    /* ---------- loading ---------- */

    async function loadTodoData(projectId) {
        const loadingEl = document.getElementById("todoLoadingState");
        const emptyEl = document.getElementById("todoEmptyState");
        if (loadingEl) loadingEl.style.display = "block";
        if (emptyEl) emptyEl.style.display = "none";

        const [itemsResult, subitemsResult] = await Promise.all([
            window.supabaseClient
                .from(TODO_ITEMS_TABLE)
                .select("*")
                .eq("project_id", projectId)
                .order("position", { ascending: true })
                .order("created_at", { ascending: true }),
            window.supabaseClient
                .from(TODO_SUBITEMS_TABLE)
                .select("*")
                .eq("project_id", projectId)
                .order("position", { ascending: true })
                .order("created_at", { ascending: true })
        ]);

        if (loadingEl) loadingEl.style.display = "none";

        if (itemsResult.error || subitemsResult.error) {
            console.error("Failed to load project to-do:", itemsResult.error || subitemsResult.error);
            setTodoPageMessage("Couldn't load this project's to-do list. Please try again.", "error");
            return;
        }

        todoItems = itemsResult.data || [];
        subitemsByItemId = {};
        (subitemsResult.data || []).forEach(sub => {
            (subitemsByItemId[sub.todo_item_id] = subitemsByItemId[sub.todo_item_id] || []).push(sub);
        });

        renderTodoItemList();
    }

    /* ---------- big item list ---------- */

    function renderTodoItemList() {
        const listEl = document.getElementById("todoItemList");
        const emptyEl = document.getElementById("todoEmptyState");
        if (!listEl) return;

        if (todoItems.length === 0) {
            listEl.innerHTML = "";
            if (emptyEl) emptyEl.style.display = "block";
            return;
        }
        if (emptyEl) emptyEl.style.display = "none";

        listEl.innerHTML = todoItems.map(item => {
            const isOpen = openPanelItem && String(openPanelItem.id) === String(item.id);
            return `
                <div class="todo-item-row ${item.completed ? "is-completed" : ""} ${isOpen ? "is-open" : ""}" data-item-id="${item.id}">
                    <input type="checkbox" class="todo-item-checkbox" data-action="toggle-complete" ${item.completed ? "checked" : ""} aria-label="Mark complete">
                    <span class="todo-item-row-title" data-action="open">${escapeHtmlTodo(item.title)}</span>
                </div>
            `;
        }).join("");

        listEl.querySelectorAll('[data-action="open"]').forEach(el => {
            el.addEventListener("click", () => {
                const item = todoItems.find(i => String(i.id) === el.closest(".todo-item-row").dataset.itemId);
                if (item) openTodoPanel(item);
            });
        });

        listEl.querySelectorAll('[data-action="toggle-complete"]').forEach(checkbox => {
            checkbox.addEventListener("click", (e) => e.stopPropagation());
            checkbox.addEventListener("change", () => {
                toggleTodoItemCompleted(checkbox.closest(".todo-item-row").dataset.itemId, checkbox.checked);
            });
        });
    }

    async function toggleTodoItemCompleted(itemId, completed) {
        const item = todoItems.find(i => String(i.id) === String(itemId));
        if (!item) return;

        const { error } = await window.supabaseClient
            .from(TODO_ITEMS_TABLE)
            .update({ completed })
            .eq("id", itemId);

        if (error) {
            console.error("Failed to update item:", error);
            setTodoPageMessage("Couldn't update that item. Please try again.", "error");
            renderTodoItemList(); // revert the checkbox to match server state
            return;
        }

        item.completed = completed;
        renderTodoItemList();
    }

    /* ---------- side panel ---------- */

    function openTodoPanel(item) {
        openPanelItem = item;
        renderTodoItemList(); // highlight this row as open
        setTodoPanelMessage("");

        const titleEl = document.getElementById("todoPanelTitle");
        if (titleEl) titleEl.textContent = item.title;

        renderPanelChecklist();

        const assigneeSelect = document.getElementById("newSubitemAssigneeSelect");
        if (assigneeSelect) assigneeSelect.innerHTML = assigneeSelectOptionsHtml(null);
        const labelInput = document.getElementById("newSubitemLabelInput");
        if (labelInput) labelInput.value = "";

        const panel = document.getElementById("todoPanel");
        if (!panel) return;
        panel.classList.remove("hidden");
        // Force layout, then add the open class so the slide-in transition runs.
        void panel.offsetWidth;
        panel.classList.add("is-open");
        document.body.classList.add("todo-panel-open"); // pushes .main-content over
    }

    function closeTodoPanel() {
        const panel = document.getElementById("todoPanel");
        if (!panel || !panel.classList.contains("is-open")) return;
        panel.classList.remove("is-open");
        document.body.classList.remove("todo-panel-open");
        openPanelItem = null;
        renderTodoItemList(); // drop the open-row highlight right away
        setTimeout(() => {
            panel.classList.add("hidden");
        }, 250);
    }

    function renderPanelChecklist() {
        const container = document.getElementById("todoPanelChecklist");
        if (!container || !openPanelItem) return;

        const subs = subitemsByItemId[openPanelItem.id] || [];

        if (!subs.length) {
            container.innerHTML = `<p class="auth-inline-copy">No checklist items yet — add one below.</p>`;
            return;
        }

        container.innerHTML = subs.map(sub => `
            <div class="todo-subitem-row ${sub.completed ? "is-completed" : ""}" data-subitem-id="${sub.id}">
                <button type="button" class="todo-subitem-check ${sub.completed ? "is-checked" : ""}" data-action="toggle" aria-label="Mark complete"></button>
                <span class="todo-subitem-label">${escapeHtmlTodo(sub.label)}</span>
                <select class="todo-subitem-assignee" data-action="assign">${assigneeSelectOptionsHtml(sub.assigned_to)}</select>
                <button type="button" class="todo-subitem-remove" data-action="delete" aria-label="Delete item">✕</button>
            </div>
        `).join("");

        container.querySelectorAll('[data-action="toggle"]').forEach(btn => {
            btn.addEventListener("click", () => toggleSubitem(btn.closest(".todo-subitem-row").dataset.subitemId));
        });
        container.querySelectorAll('[data-action="assign"]').forEach(select => {
            select.addEventListener("change", () => reassignSubitem(select.closest(".todo-subitem-row").dataset.subitemId, select.value));
        });
        container.querySelectorAll('[data-action="delete"]').forEach(btn => {
            btn.addEventListener("click", () => deleteSubitem(btn.closest(".todo-subitem-row").dataset.subitemId));
        });
    }

    function findSubitem(subitemId) {
        for (const list of Object.values(subitemsByItemId)) {
            const match = list.find(s => String(s.id) === String(subitemId));
            if (match) return match;
        }
        return null;
    }

    async function toggleSubitem(subitemId) {
        const sub = findSubitem(subitemId);
        if (!sub) return;
        const nextCompleted = !sub.completed;

        const { error } = await window.supabaseClient
            .from(TODO_SUBITEMS_TABLE)
            .update({ completed: nextCompleted })
            .eq("id", subitemId);

        if (error) {
            console.error("Failed to update checklist item:", error);
            setTodoPanelMessage("Couldn't update that item. Please try again.", "error");
            return;
        }

        sub.completed = nextCompleted;
        renderPanelChecklist();
        renderTodoItemList();
    }

    async function reassignSubitem(subitemId, newAssigneeId) {
        const sub = findSubitem(subitemId);
        if (!sub) return;

        const newAssigneeName = newAssigneeId ? staffNameById(newAssigneeId) : null;

        const { error } = await window.supabaseClient
            .from(TODO_SUBITEMS_TABLE)
            .update({ assigned_to: newAssigneeId || null, assigned_to_name: newAssigneeName })
            .eq("id", subitemId);

        if (error) {
            console.error("Failed to reassign checklist item:", error);
            setTodoPanelMessage("Couldn't reassign that item. Please try again.", "error");
            return;
        }

        sub.assigned_to = newAssigneeId || null;
        sub.assigned_to_name = newAssigneeName;

        if (newAssigneeId) {
            notifyAssignee(newAssigneeId, sub.label);
        }
    }

    async function deleteSubitem(subitemId) {
        const { error } = await window.supabaseClient
            .from(TODO_SUBITEMS_TABLE)
            .delete()
            .eq("id", subitemId);

        if (error) {
            console.error("Failed to delete checklist item:", error);
            setTodoPanelMessage("Couldn't delete that item. Please try again.", "error");
            return;
        }

        if (openPanelItem) {
            subitemsByItemId[openPanelItem.id] = (subitemsByItemId[openPanelItem.id] || []).filter(s => String(s.id) !== String(subitemId));
        }
        renderPanelChecklist();
        renderTodoItemList();
    }

    async function addSubitem() {
        if (!openPanelItem || !currentProject) return;

        const labelInput = document.getElementById("newSubitemLabelInput");
        const assigneeSelect = document.getElementById("newSubitemAssigneeSelect");
        const label = labelInput?.value.trim();

        if (!label) {
            setTodoPanelMessage("Give the checklist item some text first.", "error");
            labelInput?.focus();
            return;
        }

        const assigneeId = assigneeSelect?.value || null;
        const assigneeName = assigneeId ? staffNameById(assigneeId) : null;
        const position = (subitemsByItemId[openPanelItem.id] || []).length;

        const { data: inserted, error } = await window.supabaseClient
            .from(TODO_SUBITEMS_TABLE)
            .insert({
                todo_item_id: openPanelItem.id,
                project_id: currentProject.id,
                label,
                assigned_to: assigneeId,
                assigned_to_name: assigneeName,
                position
            })
            .select()
            .single();

        if (error) {
            console.error("Failed to add checklist item:", error);
            setTodoPanelMessage("Couldn't add that item. Please try again.", "error");
            return;
        }

        (subitemsByItemId[openPanelItem.id] = subitemsByItemId[openPanelItem.id] || []).push(inserted);
        renderPanelChecklist();
        renderTodoItemList();
        setTodoPanelMessage("");

        if (labelInput) labelInput.value = "";
        if (assigneeSelect) assigneeSelect.value = "";
        labelInput?.focus();

        if (assigneeId) notifyAssignee(assigneeId, label);
    }

    async function notifyAssignee(assigneeId, itemLabel) {
        if (!currentProject) return;
        try {
            await window.supabaseClient.from("notifications").insert({
                user_id: assigneeId,
                title: "New project to-do",
                message: `You were assigned "${itemLabel}" on ${currentProject.name || "a project"}.`,
                type: "project_todo_assignment",
                link_url: `project-to-do.html?id=${encodeURIComponent(currentProject.id)}`,
                link_label: "View it here"
            });
        } catch (error) {
            console.error("Failed to send assignment notification:", error);
        }
    }

    /* ---------- new / delete big item ---------- */

    // Inline "+ New task" row at the bottom of the list (Notion-style) —
    // type a title, hit Enter, it's created and the input stays focused
    // and empty so you can keep adding.
    async function createTodoItemInline() {
        if (!currentProject) return;

        const input = document.getElementById("newTodoItemInlineInput");
        const messageEl = document.getElementById("todoAddItemMessage");
        const title = input?.value.trim();

        if (!title) return;

        if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }
        if (input) input.disabled = true;

        const { data: inserted, error } = await window.supabaseClient
            .from(TODO_ITEMS_TABLE)
            .insert({
                project_id: currentProject.id,
                title,
                position: todoItems.length,
                created_by_id: getTodoStaffId(),
                created_by_name: getTodoStaffName()
            })
            .select()
            .single();

        if (input) input.disabled = false;

        if (error) {
            console.error("Failed to create item:", error);
            if (messageEl) { messageEl.textContent = "Something went wrong creating that item. Please try again."; messageEl.className = "auth-message error"; }
            return;
        }

        todoItems.push(inserted);
        subitemsByItemId[inserted.id] = [];
        renderTodoItemList();

        if (input) { input.value = ""; input.focus(); }
    }

    let pendingDeleteItemId = null;

    function openDeleteTodoItemConfirm() {
        if (!openPanelItem) return;
        pendingDeleteItemId = openPanelItem.id;
        const messageEl = document.getElementById("deleteTodoItemConfirmMessage");
        if (messageEl) messageEl.textContent = "";
        document.getElementById("deleteTodoItemConfirmOverlay")?.classList.remove("hidden");
    }

    function closeDeleteTodoItemConfirm() {
        document.getElementById("deleteTodoItemConfirmOverlay")?.classList.add("hidden");
        pendingDeleteItemId = null;
    }

    async function confirmDeleteTodoItem() {
        if (!pendingDeleteItemId) return;
        const itemId = pendingDeleteItemId;
        const confirmBtn = document.getElementById("confirmDeleteTodoItemBtn");
        const messageEl = document.getElementById("deleteTodoItemConfirmMessage");
        if (confirmBtn) confirmBtn.disabled = true;

        const { error } = await window.supabaseClient
            .from(TODO_ITEMS_TABLE)
            .delete()
            .eq("id", itemId);

        if (confirmBtn) confirmBtn.disabled = false;

        if (error) {
            console.error("Failed to delete item:", error);
            if (messageEl) messageEl.textContent = "Something went wrong deleting this item. Please try again.";
            return;
        }

        todoItems = todoItems.filter(i => String(i.id) !== String(itemId));
        delete subitemsByItemId[itemId];

        closeDeleteTodoItemConfirm();
        closeTodoPanel();
        renderTodoItemList();
        setTodoPageMessage("Item deleted.", "success");
    }

    /* ---------- init ---------- */

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;
        currentProject = project;

        const addRowInput = document.getElementById("newTodoItemInlineInput");
        const heroNameEl = document.getElementById("todoHeroName");

        if (error || !project) {
            setTodoPageMessage("No project selected. Pick one from Project Overview.", "error");
            document.getElementById("todoLoadingState").style.display = "none";
            if (addRowInput) addRowInput.disabled = true;
            return;
        }

        if (heroNameEl) heroNameEl.textContent = `Project To-Do — ${project.name || "Untitled project"}`;
        if (addRowInput) addRowInput.disabled = false;

        await loadStaffDirectory();
        await loadTodoData(project.id);
    });

    document.addEventListener("DOMContentLoaded", () => {
        document.getElementById("newTodoItemInlineInput")?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); createTodoItemInline(); }
        });

        document.getElementById("closeTodoPanelBtn")?.addEventListener("click", closeTodoPanel);
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") closeTodoPanel();
        });

        document.getElementById("addSubitemBtn")?.addEventListener("click", addSubitem);
        document.getElementById("newSubitemLabelInput")?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); addSubitem(); }
        });

        document.getElementById("deleteTodoItemFromPanelBtn")?.addEventListener("click", openDeleteTodoItemConfirm);
        document.getElementById("cancelDeleteTodoItemBtn")?.addEventListener("click", closeDeleteTodoItemConfirm);
        document.getElementById("confirmDeleteTodoItemBtn")?.addEventListener("click", confirmDeleteTodoItem);
        document.getElementById("deleteTodoItemConfirmOverlay")?.addEventListener("click", (e) => {
            if (e.target === e.currentTarget) closeDeleteTodoItemConfirm();
        });
    });
})();
