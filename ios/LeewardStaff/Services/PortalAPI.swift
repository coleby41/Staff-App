import Foundation
import Supabase

/// Every database / storage call the native screens make, each one mirroring
/// the web portal's query (file + function noted on each) so both stay in
/// step with the same tables and RLS rules.
enum PortalAPI {

    // MARK: Tasks (js/dashboard/task.js, pages/my-tasks.html)

    static func openTasks(userId: String, limit: Int? = nil) async throws -> [TaskItem] {
        let base = supabase
            .from("tasks")
            .select("id, task_name, due_date, description, completed")
            .eq("user_id", value: userId)
            .eq("completed", value: false)
            .order("due_date", ascending: true, nullsFirst: false)
        if let limit {
            return try await base.limit(limit).execute().value
        }
        return try await base.execute().value
    }

    static func allTasks(userId: String) async throws -> [TaskItem] {
        try await supabase
            .from("tasks")
            .select("id, task_name, due_date, description, completed")
            .eq("user_id", value: userId)
            .order("completed", ascending: true)
            .order("due_date", ascending: true, nullsFirst: false)
            .execute()
            .value
    }

    static func setTaskCompleted(id: String, completed: Bool) async throws {
        try await supabase
            .from("tasks")
            .update(["completed": completed])
            .eq("id", value: id)
            .execute()
    }

    static func addTask(_ task: NewTask) async throws {
        try await supabase.from("tasks").insert(task).execute()
    }

    // MARK: Project to-dos assigned to me (js/staff-todo.js)

    struct AssignedTodoEntry: Identifiable {
        let item: ProjectTodoSubitem
        let parentTitle: String
        var id: String { item.id }
    }

    struct AssignedTodoGroup: Identifiable {
        let projectId: String
        let projectName: String
        var items: [AssignedTodoEntry]
        var id: String { projectId }
    }

    static func assignedProjectTodos(staffId: String) async throws -> [AssignedTodoGroup] {
        let subitems: [ProjectTodoSubitem] = try await supabase
            .from("project_todo_subitems")
            .select("id, label, project_id, todo_item_id, due_date, created_at")
            .eq("assigned_to", value: staffId)
            .eq("completed", value: false)
            .order("due_date", ascending: true, nullsFirst: false)
            .order("created_at", ascending: true)
            .execute()
            .value
        guard !subitems.isEmpty else { return [] }

        let itemIds = Array(Set(subitems.compactMap(\.todoItemId)))
        let projectIds = Array(Set(subitems.map(\.projectId)))

        async let itemsReq: [IdTitle] = supabase.from("project_todo_items").select("id, title").in("id", values: itemIds).execute().value
        async let projectsReq: [IdName] = supabase.from("projects").select("id, name").in("id", values: projectIds).execute().value
        let (items, projects) = try await (itemsReq, projectsReq)

        let titleById = Dictionary(items.map { ($0.id, $0.title ?? "") }, uniquingKeysWith: { a, _ in a })
        let nameById = Dictionary(projects.map { ($0.id, $0.name ?? "Untitled project") }, uniquingKeysWith: { a, _ in a })

        // Grouped by project, in order of each project's most urgent item (same as the web).
        var groups: [AssignedTodoGroup] = []
        var indexById: [String: Int] = [:]
        for sub in subitems {
            let entry = AssignedTodoEntry(item: sub, parentTitle: titleById[sub.todoItemId ?? ""] ?? "")
            if let i = indexById[sub.projectId] {
                groups[i].items.append(entry)
            } else {
                indexById[sub.projectId] = groups.count
                groups.append(AssignedTodoGroup(projectId: sub.projectId, projectName: nameById[sub.projectId] ?? "Untitled project", items: [entry]))
            }
        }
        return groups
    }

    static func completeProjectTodo(id: String) async throws {
        try await supabase
            .from("project_todo_subitems")
            .update(["completed": true])
            .eq("id", value: id)
            .execute()
    }

    // MARK: Notifications (js/notification-center.js)

    static func notifications(staffId: String, offset: Int, pageSize: Int) async throws -> (items: [AppNotification], readIds: Set<String>) {
        let rows: [AppNotification] = try await supabase
            .from("notifications")
            .select("*")
            .or("user_id.is.null,user_id.eq.\(staffId)")
            .order("created_at", ascending: false)
            .range(from: offset, to: offset + pageSize - 1)
            .execute()
            .value
        guard !rows.isEmpty else { return ([], []) }

        let reads: [NotificationReadRow] = try await supabase
            .from("notification_reads")
            .select("notification_id")
            .eq("staff_user_id", value: staffId)
            .in("notification_id", values: rows.map(\.id))
            .execute()
            .value
        return (rows, Set(reads.map(\.notificationId)))
    }

    static func markNotificationsRead(ids: [String], staffId: String) async throws {
        guard !ids.isEmpty else { return }
        try await supabase
            .from("notification_reads")
            .upsert(
                ids.map { NotificationReadInsert(notificationId: $0, staffUserId: staffId) },
                onConflict: "notification_id,staff_user_id",
                ignoreDuplicates: true
            )
            .execute()
    }

    /// The bell's unread count: newest notifications for me minus ones I've read.
    static func unreadCount(staffId: String) async throws -> Int {
        let page = try await notifications(staffId: staffId, offset: 0, pageSize: 50)
        return page.items.filter { !page.readIds.contains($0.id) }.count
    }

    // MARK: Projects (js/projects-page.js, js/dashboard/projects.js)

    /// projects_overview masks the money fields for anyone without financial
    /// access on that project (see supabase-rls-lockdown.sql), so always read
    /// through it, never the base table.
    static func projects() async throws -> [Project] {
        try await supabase
            .from("projects_overview")
            .select("*")
            .order("name", ascending: true)
            .execute()
            .value
    }

    static func project(id: String) async throws -> Project? {
        let rows: [Project] = try await supabase
            .from("projects_overview")
            .select("*")
            .eq("id", value: id)
            .limit(1)
            .execute()
            .value
        return rows.first
    }

    static func activeProjectCount() async throws -> Int {
        let response = try await supabase
            .from("projects")
            .select("id", head: true, count: .exact)
            .eq("is_active", value: true)
            .execute()
        return response.count ?? 0
    }

    /// Remaining deadlines this month (dashboard "Project Snapshot").
    static func upcomingDeadlines(limit: Int = 6) async throws -> [ProjectDeadline] {
        let cal = Calendar.current
        let today = Date()
        let endOfMonth = cal.date(byAdding: DateComponents(month: 1, day: -1), to: cal.date(from: cal.dateComponents([.year, .month], from: today))!)!
        return try await supabase
            .from("project_deadlines")
            .select("id, title, site, deadline_date, projects(name)")
            .gte("deadline_date", value: DateText.isoString(from: today))
            .lte("deadline_date", value: DateText.isoString(from: endOfMonth))
            .order("deadline_date", ascending: true)
            .limit(limit)
            .execute()
            .value
    }

    /// Active projects for pickers (incident-report.js loadIrProjects()).
    static func pickerProjects() async throws -> [ProjectPickerItem] {
        let rows: [ProjectPickerItem] = try await supabase
            .from("projects")
            .select("id, name, project_code, is_active")
            .order("name", ascending: true)
            .execute()
            .value
        return rows.filter { $0.isActive != false }
    }

    // MARK: Project files (js/project-files.js)

    static func projectFiles(projectId: String) async throws -> [ProjectFile] {
        try await supabase
            .from("project_files")
            .select("*, form_submissions(form_title)")
            .eq("project_id", value: projectId)
            .order("created_at", ascending: false)
            .execute()
            .value
    }

    /// Downloads a file to a temporary location (for Quick Look / sharing).
    static func downloadToTemp(_ file: ProjectFile) async throws -> URL {
        let data = try await supabase.storage.from(file.storageBucket).download(path: file.storagePath)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(file.id, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(file.fileName.isEmpty ? "file" : file.fileName)
        try data.write(to: url, options: .atomic)
        return url
    }

    /// Same storage path convention + project_files row as the web upload:
    /// project-documents / <projectId>/<category>/<subfolder>[/<subSub>]/<ms>-<safeName>
    static func uploadProjectFile(projectId: String, category: String, subfolder: String, subSubfolder: String?,
                                  fileName: String, data: Data, contentType: String?, uploadedByName: String) async throws -> ProjectFile {
        let segments = [projectId, category, subfolder, subSubfolder].compactMap { $0 }.filter { !$0.isEmpty }
        let path = segments.joined(separator: "/") + "/\(jsNowMillis())-\(safeStorageName(fileName))"

        try await supabase.storage
            .from("project-documents")
            .upload(path: path, data: data, options: FileOptions(contentType: contentType, shouldUpsert: false))

        let row = NewProjectFile(
            projectId: projectId, category: category, subfolder: subfolder, subSubfolder: subSubfolder,
            storagePath: path, fileName: fileName, uploadedByName: uploadedByName
        )
        do {
            return try await supabase
                .from("project_files")
                .insert(row)
                .select("*, form_submissions(form_title)")
                .single()
                .execute()
                .value
        } catch {
            // Don't leave an orphaned file in storage if the row couldn't be saved.
            _ = try? await supabase.storage.from("project-documents").remove(paths: [path])
            throw error
        }
    }

    // MARK: Contacts (js/project-accounts.js)

    static func contacts(projectId: String) async throws -> [ProjectContact] {
        try await supabase
            .from("project_contacts")
            .select("*")
            .eq("project_id", value: projectId)
            .order("created_at", ascending: true)
            .execute()
            .value
    }

    // MARK: Incident reports (js/incident-report.js)

    static func approverSetting(projectId: String) async throws -> IncidentApproverSetting? {
        let rows: [IncidentApproverSetting] = try await supabase
            .from("incident_report_settings")
            .select("default_approver_id, default_approver_name")
            .eq("project_id", value: projectId)
            .limit(1)
            .execute()
            .value
        return rows.first
    }

    struct PendingAttachment: Identifiable {
        let id = UUID()
        let name: String
        let data: Data
        let contentType: String
        /// "image" or "pdf", same values the web stores.
        let kind: String
    }

    /// handleSubmit(): insert the report (a DB trigger stamps the approver and
    /// status), upload attachments to incident-report-attachments under
    /// <reportId>/attachments/, save their metadata, then notify the approver.
    static func submitIncidentReport(_ report: NewIncidentReport, attachments: [PendingAttachment],
                                     projectName: String?, submitterName: String) async throws {
        let inserted: InsertedIncidentReport = try await supabase
            .from("incident_reports")
            .insert(report)
            .select()
            .single()
            .execute()
            .value

        if !attachments.isEmpty {
            var metadata: [IncidentAttachmentMeta] = []
            for (index, attachment) in attachments.enumerated() {
                let path = "\(inserted.id)/attachments/\(jsNowMillis())-\(index)-\(safeStorageName(attachment.name))"
                try await supabase.storage
                    .from("incident-report-attachments")
                    .upload(path: path, data: attachment.data,
                            options: FileOptions(cacheControl: "3600", contentType: attachment.contentType, shouldUpsert: true))
                metadata.append(IncidentAttachmentMeta(name: attachment.name, path: path, kind: attachment.kind))
            }
            try await supabase
                .from("incident_reports")
                .update(IncidentAttachmentsUpdate(attachments: metadata))
                .eq("id", value: inserted.id)
                .execute()
        }

        if let approverId = inserted.assignedApproverId {
            // Best effort, like the web: a failed notification doesn't fail the report.
            _ = try? await supabase.from("notifications").insert(NewNotification(
                userId: approverId,
                title: "Incident Report needs your approval",
                message: "\(submitterName) submitted an Incident Report for \(projectName ?? "a project"). Review it on your Account Activity page.",
                type: "incident_report_assigned",
                linkUrl: "/pages/account-activity.html",
                linkLabel: "Review it here"
            )).execute()
        }
    }
}
