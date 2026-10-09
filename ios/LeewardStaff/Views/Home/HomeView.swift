import SwiftUI

/// pages/dashboard.html: greeting, My Tasks (top 4 + quick add), Project
/// Snapshot (active count + this month's deadlines), and the notifications bell.
struct HomeView: View {
    @Environment(AppState.self) private var app
    let selectTab: (MainTabView.Tab) -> Void

    @State private var tasks: [TaskItem] = []
    @State private var tasksError: String?
    @State private var newTaskName = ""
    @State private var newTaskDue: Date? = nil
    @State private var showDuePicker = false
    @State private var isAdding = false

    @State private var activeCount: Int?
    @State private var deadlines: [ProjectDeadline] = []
    @State private var unread = 0
    @State private var showNotifications = false
    @State private var loadedOnce = false

    private let maxTasks = 4

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Welcome, \(app.profile?.fullName?.split(separator: " ").first.map(String.init) ?? "Staff")")
                        .font(.largeTitle.bold())
                        .padding(.top, 4)

                    tasksCard

                    if app.can("general.view_project_overview") {
                        snapshotCard
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Theme.background)
            .refreshable { await loadAll() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    BrandMark(size: 32, text: app.profile?.initials ?? "LG")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNotifications = true } label: {
                        Image(systemName: unread > 0 ? "bell.badge" : "bell")
                            .symbolRenderingMode(.multicolor)
                    }
                    .accessibilityLabel(unread > 0 ? "Notifications, \(unread) unread" : "Notifications")
                }
            }
            .sheet(isPresented: $showNotifications, onDismiss: { Task { await loadUnread() } }) {
                NotificationsView()
            }
            .task {
                guard !loadedOnce else { return }
                loadedOnce = true
                await loadAll()
            }
        }
    }

    // MARK: My Tasks card

    private var tasksCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("My Tasks", systemImage: "checkmark.square").font(.headline)
                Spacer()
                Button("View all") { selectTab(.tasks) }
                    .font(.subheadline.weight(.semibold))
            }

            if let tasksError {
                Text(tasksError).font(.subheadline).foregroundStyle(Theme.textSoft)
            } else if tasks.isEmpty {
                Text("No open tasks — nice work.").font(.subheadline).foregroundStyle(Theme.textSoft)
            } else {
                ForEach(tasks) { task in
                    TaskRow(task: task) { await complete(task) }
                }
            }

            // Inline "+ New task" row (same as the web card).
            HStack(spacing: 10) {
                Image(systemName: "plus").foregroundStyle(Theme.textSoft)
                TextField("New task", text: $newTaskName)
                    .submitLabel(.done)
                    .onSubmit { Task { await addTask() } }
                    .disabled(isAdding)
                Button {
                    showDuePicker = true
                } label: {
                    if let newTaskDue {
                        Text(newTaskDue.formatted(.dateTime.month(.abbreviated).day())).font(.caption.weight(.semibold))
                    } else {
                        Image(systemName: "calendar")
                    }
                }
                .accessibilityLabel("Due date")
                if !newTaskName.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button("Add") { Task { await addTask() } }
                        .font(.subheadline.weight(.semibold))
                        .disabled(isAdding)
                }
            }
            .padding(.top, 4)
        }
        .card()
        .sheet(isPresented: $showDuePicker) {
            DuePickerSheet(date: $newTaskDue)
                .presentationDetents([.medium])
        }
    }

    // MARK: Project Snapshot card

    private var snapshotCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Project Snapshot", systemImage: "chart.line.uptrend.xyaxis").font(.headline)
                Spacer()
                Button("View all projects") { selectTab(.projects) }
                    .font(.subheadline.weight(.semibold))
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(activeCount.map(String.init) ?? "—")
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(Theme.accentStrong)
                Text("Active projects").font(.subheadline).foregroundStyle(Theme.textSoft)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.background)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            Text("Upcoming deadlines").font(.subheadline.weight(.semibold))
            if deadlines.isEmpty {
                Text("No deadlines remaining this month.").font(.subheadline).foregroundStyle(Theme.textSoft)
            } else {
                ForEach(deadlines) { d in
                    HStack(spacing: 12) {
                        let date = DateText.day(d.deadlineDate)
                        VStack(spacing: 0) {
                            Text(date?.formatted(.dateTime.month(.abbreviated)).uppercased() ?? "")
                                .font(.caption2.weight(.bold)).foregroundStyle(Theme.textSoft)
                            Text(date?.formatted(.dateTime.day()) ?? "")
                                .font(.headline).foregroundStyle(Theme.accentStrong)
                        }
                        .frame(width: 44)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(d.title ?? "Deadline").font(.subheadline.weight(.semibold))
                            Text(d.site ?? d.projects?.name ?? "").font(.caption).foregroundStyle(Theme.textSoft)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(10)
                    .background(Theme.background)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }
        .card()
    }

    // MARK: Loading

    private func loadAll() async {
        async let a: Void = loadTasks()
        async let b: Void = loadSnapshot()
        async let c: Void = loadUnread()
        _ = await (a, b, c)
    }

    private func loadTasks() async {
        guard let id = app.profile?.id else { return }
        do {
            tasks = try await PortalAPI.openTasks(userId: id, limit: maxTasks)
            tasksError = nil
        } catch {
            tasksError = "Couldn't load tasks right now."
        }
    }

    private func loadSnapshot() async {
        guard app.can("general.view_project_overview") else { return }
        activeCount = try? await PortalAPI.activeProjectCount()
        deadlines = (try? await PortalAPI.upcomingDeadlines()) ?? []
    }

    private func loadUnread() async {
        guard let id = app.profile?.id else { return }
        if let count = try? await PortalAPI.unreadCount(staffId: id) { unread = count }
    }

    private func complete(_ task: TaskItem) async {
        withAnimation { tasks.removeAll { $0.id == task.id } }
        do {
            try await PortalAPI.setTaskCompleted(id: task.id, completed: true)
        } catch {
            tasksError = friendlyMessage(for: error)
        }
        await loadTasks()
    }

    private func addTask() async {
        let name = newTaskName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let id = app.profile?.id else { return }
        isAdding = true
        defer { isAdding = false }
        do {
            try await PortalAPI.addTask(NewTask(
                userId: id, taskName: name,
                dueDate: newTaskDue.map(DateText.isoString(from:)),
                description: nil
            ))
            newTaskName = ""
            newTaskDue = nil
            await loadTasks()
        } catch {
            tasksError = friendlyMessage(for: error)
        }
    }
}

/// One task with a round checkbox and due pill (the web's .mytask-row).
struct TaskRow: View {
    let task: TaskItem
    var subtitle: String? = nil
    let onComplete: () async -> Void
    @State private var checking = false

    var body: some View {
        let due = DateText.due(task.dueDate)
        HStack(spacing: 12) {
            Button {
                checking = true
                Task { await onComplete(); checking = false }
            } label: {
                Image(systemName: task.completed || checking ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(task.completed || checking ? Theme.accent : Theme.textSoft)
            }
            .buttonStyle(.plain)
            .disabled(task.completed || checking)
            .accessibilityLabel("Mark \(task.taskName) complete")

            VStack(alignment: .leading, spacing: 2) {
                Text(task.taskName)
                    .font(.subheadline)
                    .strikethrough(task.completed)
                    .foregroundStyle(task.completed ? Theme.textSoft : Theme.text)
                    .lineLimit(2)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(Theme.textSoft).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            if task.completed {
                Text("Completed").font(.caption.weight(.semibold)).foregroundStyle(Theme.textSoft)
            } else if due.tier == .none || due.tier == .upcoming {
                Text(due.text).font(.caption).foregroundStyle(Theme.textSoft)
            } else {
                Pill(text: due.text, foreground: due.tier.colors.0, background: due.tier.colors.1)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(Theme.background)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct DuePickerSheet: View {
    @Binding var date: Date?
    @Environment(\.dismiss) private var dismiss
    @State private var picked = Date()

    var body: some View {
        NavigationStack {
            DatePicker("Due date", selection: $picked, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .padding()
                .navigationTitle("Due date")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Clear") { date = nil; dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { date = picked; dismiss() }
                    }
                }
                .onAppear { if let date { picked = date } }
        }
    }
}
