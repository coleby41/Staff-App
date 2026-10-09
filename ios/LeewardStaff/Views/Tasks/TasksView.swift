import SwiftUI

/// pages/my-tasks.html + pages/staff-todo.html in one tab:
/// - My Tasks (personal, Open / All, add, complete)
/// - Project To-Do items assigned to me, grouped by project
struct TasksView: View {
    @Environment(AppState.self) private var app

    enum Filter: String, CaseIterable { case open = "Open", all = "All" }
    @State private var filter: Filter = .open
    @State private var tasks: [TaskItem] = []
    @State private var groups: [PortalAPI.AssignedTodoGroup] = []
    @State private var errorText: String?
    @State private var isLoading = false
    @State private var showAdd = false
    @State private var openPage: PortalPage?

    private var shownTasks: [TaskItem] {
        filter == .open ? tasks.filter { !$0.completed } : tasks
    }

    var body: some View {
        NavigationStack {
            List {
                if let errorText {
                    Section { Text(errorText).foregroundStyle(Theme.danger) }
                }

                Section {
                    Picker("Show", selection: $filter) {
                        ForEach(Filter.allCases, id: \.self) { Text($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))

                    if shownTasks.isEmpty && !isLoading {
                        Text(filter == .open ? "No open tasks — nice work." : "No tasks yet.")
                            .foregroundStyle(Theme.textSoft)
                    }
                    ForEach(shownTasks) { task in
                        TaskRow(task: task, subtitle: task.description) {
                            await setCompleted(task, true)
                        }
                        .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                        .listRowSeparator(.hidden)
                        .swipeActions(edge: .trailing) {
                            if task.completed {
                                Button("Reopen") { Task { await setCompleted(task, false) } }
                                    .tint(Theme.accent)
                            }
                        }
                    }
                } header: {
                    Text("My Tasks")
                }

                Section {
                    if groups.isEmpty && !isLoading {
                        Text("Nothing assigned to you right now.").foregroundStyle(Theme.textSoft)
                    }
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: 8) {
                            Button {
                                openPage = PortalPage(title: group.projectName,
                                                      path: "/pages/project-todo.html?id=\(group.projectId)")
                            } label: {
                                HStack {
                                    Text(group.projectName).font(.subheadline.weight(.bold))
                                    Image(systemName: "chevron.right").font(.caption.weight(.bold))
                                }
                                .foregroundStyle(Theme.accentStrong)
                            }
                            .buttonStyle(.plain)

                            ForEach(group.items) { entry in
                                let asTask = TaskItem(id: entry.item.id, taskName: entry.item.label ?? "Untitled item",
                                                      dueDate: entry.item.dueDate, description: nil, completed: false)
                                TaskRow(task: asTask, subtitle: entry.parentTitle) {
                                    await completeProjectTodo(entry.item.id)
                                }
                            }
                        }
                        .listRowSeparator(.hidden)
                    }
                } header: {
                    Text("Project To-Do")
                } footer: {
                    if !groups.isEmpty {
                        Text("Assigned to you on a project's to-do list. Tap a project name to open its list.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Tasks")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showAdd = true } label: { Label("Add task", systemImage: "plus") }
                }
            }
            .refreshable { await load() }
            .task { await load() }
            .sheet(isPresented: $showAdd) {
                AddTaskSheet { await load() }
            }
            .navigationDestination(item: $openPage) { PortalWebScreen(page: $0) }
            .overlay { if isLoading && tasks.isEmpty && groups.isEmpty { ProgressView() } }
        }
    }

    private func load() async {
        guard let id = app.profile?.id else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let t = PortalAPI.allTasks(userId: id)
            async let g = PortalAPI.assignedProjectTodos(staffId: id)
            (tasks, groups) = try await (t, g)
            errorText = nil
        } catch {
            errorText = "Couldn't load your tasks right now."
        }
    }

    private func setCompleted(_ task: TaskItem, _ completed: Bool) async {
        do {
            try await PortalAPI.setTaskCompleted(id: task.id, completed: completed)
            if let i = tasks.firstIndex(where: { $0.id == task.id }) {
                withAnimation { tasks[i].completed = completed }
            }
        } catch {
            errorText = friendlyMessage(for: error)
        }
    }

    private func completeProjectTodo(_ id: String) async {
        do {
            try await PortalAPI.completeProjectTodo(id: id)
            withAnimation {
                for i in groups.indices { groups[i].items.removeAll { $0.item.id == id } }
                groups.removeAll { $0.items.isEmpty }
            }
        } catch {
            errorText = friendlyMessage(for: error)
        }
    }
}

/// The web's "Add new task" popup: name, optional due date, optional description.
struct AddTaskSheet: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    let onSaved: () async -> Void

    @State private var name = ""
    @State private var hasDue = false
    @State private var due = Date()
    @State private var details = ""
    @State private var isSaving = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What needs doing?", text: $name)
                }
                Section {
                    Toggle("Due date", isOn: $hasDue.animation())
                    if hasDue {
                        DatePicker("Due", selection: $due, displayedComponents: .date)
                    }
                }
                Section("Notes") {
                    TextField("Optional details", text: $details, axis: .vertical)
                        .lineLimit(3...8)
                }
                if let errorText {
                    Section { Text(errorText).foregroundStyle(Theme.danger) }
                }
            }
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Add") { Task { await save() } }
                        .disabled(isSaving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() async {
        guard let id = app.profile?.id else { return }
        isSaving = true
        defer { isSaving = false }
        let trimmedDetails = details.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await PortalAPI.addTask(NewTask(
                userId: id,
                taskName: name.trimmingCharacters(in: .whitespacesAndNewlines),
                dueDate: hasDue ? DateText.isoString(from: due) : nil,
                description: trimmedDetails.isEmpty ? nil : trimmedDetails
            ))
            await onSaved()
            dismiss()
        } catch {
            errorText = friendlyMessage(for: error)
        }
    }
}
