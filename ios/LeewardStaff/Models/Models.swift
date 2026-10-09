import Foundation

// Column names are spelled out in CodingKeys on purpose: supabase-swift does
// not convert snake_case automatically, and this keeps every model a 1:1
// match with the table it comes from. All ids are uuids (stored as String).

// MARK: - staff_users

struct StaffProfile: Codable, Identifiable, Equatable {
    let id: String
    let username: String?
    let fullName: String?
    /// staff_users.workgroup can be a single text value or an array; the web
    /// handles both (supabase-auth.js getSupabaseUserGroups), so do we.
    let workgroups: [String]
    let role: String?
    let active: Bool?
    let mustResetPassword: Bool?
    let authUserId: String?

    enum CodingKeys: String, CodingKey {
        case id, username, role, active
        case fullName = "full_name"
        case workgroups = "workgroup"
        case mustResetPassword = "must_reset_password"
        case authUserId = "auth_user_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        username = try c.decodeIfPresent(String.self, forKey: .username)
        fullName = try c.decodeIfPresent(String.self, forKey: .fullName)
        role = try c.decodeIfPresent(String.self, forKey: .role)
        active = try c.decodeIfPresent(Bool.self, forKey: .active)
        mustResetPassword = try c.decodeIfPresent(Bool.self, forKey: .mustResetPassword)
        authUserId = try c.decodeIfPresent(String.self, forKey: .authUserId)
        if let list = try? c.decodeIfPresent([String].self, forKey: .workgroups) {
            workgroups = list
        } else if let single = try? c.decodeIfPresent(String.self, forKey: .workgroups) {
            workgroups = [single]
        } else {
            workgroups = []
        }
    }

    var displayName: String { fullName ?? username ?? "Staff" }

    var initials: String {
        let parts = displayName.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first }.map(String.init).joined()
        return letters.isEmpty ? "ST" : letters.uppercased()
    }

    /// Lowercased, trimmed group names (same normalization as the web).
    var normalizedGroups: [String] {
        workgroups.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
    }

    func isInGroup(_ group: String) -> Bool {
        normalizedGroups.contains(group.lowercased())
    }

    var isManager: Bool {
        (role ?? "").trimmingCharacters(in: .whitespaces).lowercased() == "manager"
    }

    static let selectColumns = "id, username, full_name, workgroup, role, active, must_reset_password, auth_user_id"
}

// MARK: - tasks (personal "My Tasks")

struct TaskItem: Codable, Identifiable, Equatable {
    let id: String
    var taskName: String
    var dueDate: String?
    var description: String?
    var completed: Bool

    enum CodingKeys: String, CodingKey {
        case id, description, completed
        case taskName = "task_name"
        case dueDate = "due_date"
    }
}

struct NewTask: Encodable {
    let userId: String
    let taskName: String
    let dueDate: String?
    let description: String?
    let completed = false

    enum CodingKeys: String, CodingKey {
        case description, completed
        case userId = "user_id"
        case taskName = "task_name"
        case dueDate = "due_date"
    }
}

// MARK: - project_todo_subitems (project to-dos assigned to me)

struct ProjectTodoSubitem: Codable, Identifiable, Equatable {
    let id: String
    let label: String?
    let projectId: String
    let todoItemId: String?
    let dueDate: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, label
        case projectId = "project_id"
        case todoItemId = "todo_item_id"
        case dueDate = "due_date"
        case createdAt = "created_at"
    }
}

struct IdTitle: Codable { let id: String; let title: String? }
struct IdName: Codable { let id: String; let name: String? }

// MARK: - notifications

struct AppNotification: Codable, Identifiable, Equatable {
    let id: String
    let title: String?
    let message: String?
    let linkUrl: String?
    let linkLabel: String?
    let createdAt: String?
    let userId: String?

    enum CodingKeys: String, CodingKey {
        case id, title, message
        case linkUrl = "link_url"
        case linkLabel = "link_label"
        case createdAt = "created_at"
        case userId = "user_id"
    }
}

struct NotificationReadRow: Codable {
    let notificationId: String
    enum CodingKeys: String, CodingKey { case notificationId = "notification_id" }
}

struct NotificationReadInsert: Encodable {
    let notificationId: String
    let staffUserId: String
    enum CodingKeys: String, CodingKey {
        case notificationId = "notification_id"
        case staffUserId = "staff_user_id"
    }
}

// MARK: - projects / projects_overview

/// Decodes a JSON number OR a numeric string (Postgres numeric can arrive either way).
struct FlexibleDouble: Codable, Equatable {
    let value: Double?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = nil }
        else if let d = try? c.decode(Double.self) { value = d }
        else if let s = try? c.decode(String.self) { value = Double(s) }
        else { value = nil }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(value)
    }
}

struct Project: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let name: String?
    let status: String?
    let siteAddress: String?
    let siteCity: String?
    let siteState: String?
    let siteZip: String?
    let projectCode: String?
    let projectManagerName: String?
    let gcName: String?
    let contractValueRaw: FlexibleDouble?
    let progressRaw: FlexibleDouble?
    let dueDate: String?
    let coverPhotoUrl: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, status
        case siteAddress = "site_address"
        case siteCity = "site_city"
        case siteState = "site_state"
        case siteZip = "site_zip"
        case projectCode = "project_code"
        case projectManagerName = "project_manager_name"
        case gcName = "gc_name"
        case contractValueRaw = "contract_value"
        case progressRaw = "progress_percent"
        case dueDate = "due_date"
        case coverPhotoUrl = "cover_photo_url"
        case updatedAt = "updated_at"
    }

    static func == (a: Project, b: Project) -> Bool { a.id == b.id && a.updatedAt == b.updatedAt && a.status == b.status }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    var displayName: String { (name?.isEmpty == false ? name : nil) ?? "Untitled project" }
    var statusKey: String { status ?? "onboarding" }
    var contractValue: Double? { contractValueRaw?.value }
    var progress: Double? { progressRaw?.value }

    var addressLine: String {
        let cityState = [siteCity, siteState].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: ", ")
        return [siteAddress, cityState.isEmpty ? nil : cityState]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: " · ")
    }
}

/// projects.html's canonical status list (project-fields.js PROJECT_STATUSES).
enum ProjectStatus: String, CaseIterable, Identifiable {
    case active, onboarding, onHold = "on_hold", completed, archived
    var id: String { rawValue }
    var label: String {
        switch self {
        case .active: return "Active"
        case .onboarding: return "Onboarding"
        case .onHold: return "On Hold"
        case .completed: return "Completed"
        case .archived: return "Archived"
        }
    }
    static func label(for key: String) -> String {
        ProjectStatus(rawValue: key)?.label ?? key.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

struct ProjectPickerItem: Codable, Identifiable, Hashable {
    let id: String
    let name: String?
    let projectCode: String?
    let isActive: Bool?
    enum CodingKeys: String, CodingKey {
        case id, name
        case projectCode = "project_code"
        case isActive = "is_active"
    }
    var displayName: String { (name?.isEmpty == false ? name : nil) ?? "Untitled project" }
}

// MARK: - project_deadlines

struct ProjectDeadline: Codable, Identifiable {
    struct ProjectRef: Codable { let name: String? }
    let id: String
    let title: String?
    let site: String?
    let deadlineDate: String
    let projects: ProjectRef?

    enum CodingKeys: String, CodingKey {
        case id, title, site, projects
        case deadlineDate = "deadline_date"
    }
}

// MARK: - project_files

struct ProjectFile: Codable, Identifiable, Equatable {
    struct FormRef: Codable, Equatable { let formTitle: String?
        enum CodingKeys: String, CodingKey { case formTitle = "form_title" } }

    let id: String
    let projectId: String
    let category: String
    let subfolder: String
    let subSubfolder: String?
    let bucket: String?
    let storagePath: String
    let fileName: String
    let source: String?
    let uploadedByName: String?
    let createdAt: String?
    let formSubmissions: FormRef?

    enum CodingKeys: String, CodingKey {
        case id, category, subfolder, bucket, source
        case projectId = "project_id"
        case subSubfolder = "sub_subfolder"
        case storagePath = "storage_path"
        case fileName = "file_name"
        case uploadedByName = "uploaded_by_name"
        case createdAt = "created_at"
        case formSubmissions = "form_submissions"
    }

    /// Same rule as project-files.js: form PDFs live in their own bucket.
    var storageBucket: String {
        bucket == "form-submissions" ? "form-submissions" : "project-documents"
    }
}

struct NewProjectFile: Encodable {
    let projectId: String
    let category: String
    let subfolder: String
    let subSubfolder: String?
    let bucket = "project-documents"
    let storagePath: String
    let fileName: String
    let source = "upload"
    let uploadedByName: String

    enum CodingKeys: String, CodingKey {
        case category, subfolder, bucket, source
        case projectId = "project_id"
        case subSubfolder = "sub_subfolder"
        case storagePath = "storage_path"
        case fileName = "file_name"
        case uploadedByName = "uploaded_by_name"
    }
}

// MARK: - project_contacts

struct ProjectContact: Codable, Identifiable {
    let id: String
    let contactType: String?
    let fullName: String?
    let title: String?
    let companyName: String?
    let phone: String?
    let email: String?
    let notes: String?

    enum CodingKeys: String, CodingKey {
        case id, title, phone, email, notes
        case contactType = "contact_type"
        case fullName = "full_name"
        case companyName = "company_name"
    }
}

/// project-fields.js CONTACT_TYPES, in the same order.
enum ContactType: String, CaseIterable {
    case propertyOwner = "property_owner"
    case generalContractor = "general_contractor"
    case pointOfContact = "point_of_contact"
    case utilities
    case trashPortaPotties = "trash_porta_potties"
    case countyCityOffice = "county_city_office"
    case other

    var label: String {
        switch self {
        case .propertyOwner: return "Property Owner"
        case .generalContractor: return "General Contractor"
        case .pointOfContact: return "Project Point of Contact"
        case .utilities: return "Utilities"
        case .trashPortaPotties: return "Trash / Porta Potties"
        case .countyCityOffice: return "County / City Office"
        case .other: return "Other"
        }
    }

    var symbol: String {
        switch self {
        case .propertyOwner: return "person.crop.circle"
        case .generalContractor: return "building.2"
        case .pointOfContact: return "person.text.rectangle"
        case .utilities: return "drop"
        case .trashPortaPotties: return "trash"
        case .countyCityOffice: return "building.columns"
        case .other: return "person"
        }
    }
}

// MARK: - incident reports

struct IncidentApproverSetting: Codable {
    let defaultApproverId: String?
    let defaultApproverName: String?
    enum CodingKeys: String, CodingKey {
        case defaultApproverId = "default_approver_id"
        case defaultApproverName = "default_approver_name"
    }
}

struct NewIncidentReport: Encodable {
    let projectId: String
    let reportDate: String
    let price: Double
    let buildings: String
    let unitNumbers: String
    let personMakingReport: String
    let reasonForReport: String
    let changeInScope: String?
    let whoCausedIssue: String
    let submittedBy: String
    let submittedByName: String

    enum CodingKeys: String, CodingKey {
        case price, buildings
        case projectId = "project_id"
        case reportDate = "report_date"
        case unitNumbers = "unit_numbers"
        case personMakingReport = "person_making_report"
        case reasonForReport = "reason_for_report"
        case changeInScope = "change_in_scope"
        case whoCausedIssue = "who_caused_issue"
        case submittedBy = "submitted_by"
        case submittedByName = "submitted_by_name"
    }
}

struct InsertedIncidentReport: Codable {
    let id: String
    let assignedApproverId: String?
    enum CodingKeys: String, CodingKey {
        case id
        case assignedApproverId = "assigned_approver_id"
    }
}

struct IncidentAttachmentMeta: Codable {
    let name: String
    let path: String
    let kind: String
}

struct IncidentAttachmentsUpdate: Encodable {
    let attachments: [IncidentAttachmentMeta]
}

struct NewNotification: Encodable {
    let userId: String
    let title: String
    let message: String
    let type: String
    let linkUrl: String
    let linkLabel: String
    enum CodingKeys: String, CodingKey {
        case title, message, type
        case userId = "user_id"
        case linkUrl = "link_url"
        case linkLabel = "link_label"
    }
}

// MARK: - permissions

struct WorkgroupRow: Codable { let id: String; let name: String? }
struct WorkgroupPermissionRow: Codable {
    let workgroupId: String
    let permissionKey: String
    enum CodingKeys: String, CodingKey {
        case workgroupId = "workgroup_id"
        case permissionKey = "permission_key"
    }
}
