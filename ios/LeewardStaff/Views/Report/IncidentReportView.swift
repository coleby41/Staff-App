import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// pages/incident-report.html, natively. Same fields, same validation, same
/// submit flow (see PortalAPI.submitIncidentReport). The approver is set per
/// project on the web (Form Settings); without one, submitting is blocked.
/// Editing / resubmitting a rejected report stays on the web (Account Activity).
struct IncidentReportView: View {
    @Environment(AppState.self) private var app

    @State private var projects: [ProjectPickerItem] = []
    @State private var projectId: String = ""
    @State private var approver: IncidentApproverSetting?
    @State private var approverLoading = false

    @State private var priceText = ""
    @State private var building = ""
    @State private var unitNumber = ""
    @State private var person = ""
    @State private var reason = ""
    @State private var changeInScope = ""
    @State private var whoCaused = ""
    @State private var attachments: [PortalAPI.PendingAttachment] = []

    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var showPDFImporter = false

    @State private var isSubmitting = false
    @State private var errorText: String?
    @State private var showSuccess = false
    @State private var showActivity = false

    private let maxAttachmentBytes = 15 * 1024 * 1024 // MAX_ATTACHMENT_MB = 15
    @FocusState private var focused: Bool

    private var canSubmitPermission: Bool { app.can("incident_reports.submit") }
    private var hasApprover: Bool { (approver?.defaultApproverId ?? "").isEmpty == false }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Date", value: todayDisplay)
                    Picker("Project", selection: $projectId) {
                        Text("Select a project…").tag("")
                        ForEach(projects) { Text($0.displayName).tag($0.id) }
                    }
                    if !projectId.isEmpty && !approverLoading && !hasApprover {
                        Label("No approver is set up for incident reports yet for this project. Ask a Super Admin or IT staff member to set one from Form Settings before you can submit.",
                              systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(Theme.danger)
                    } else if hasApprover, let name = approver?.defaultApproverName {
                        LabeledContent("Approver", value: name)
                    }
                }

                Section {
                    TextField("$0.00", text: $priceText)
                        .keyboardType(.decimalPad)
                        .focused($focused)
                } header: { Text("Price") }

                Section {
                    TextField("e.g. 1", text: $building).focused($focused)
                } header: { Text("Building") } footer: {
                    Text("One building only — this becomes the building number on any BC/VPO generated from this report. If more than one building is affected, submit a separate report for each.")
                }

                Section {
                    TextField("e.g. 311", text: $unitNumber).focused($focused)
                } header: { Text("Unit Number") }

                Section {
                    TextField("Please state YOUR full name", text: $person)
                        .textContentType(.name)
                        .focused($focused)
                } header: { Text("Person Making the Report") }

                Section {
                    TextField("What happened?", text: $reason, axis: .vertical)
                        .lineLimit(4...12)
                        .focused($focused)
                } header: { Text("Reason for Report") }

                Section {
                    TextField("Describe any change in scope", text: $changeInScope, axis: .vertical)
                        .lineLimit(3...10)
                        .focused($focused)
                } header: { Text("Change In Scope (optional)") }

                Section {
                    TextField("Please state the legal name of the vendor", text: $whoCaused)
                        .focused($focused)
                } header: { Text("Who Caused the Issue") }

                Section {
                    ForEach(attachments) { att in
                        HStack {
                            Image(systemName: att.kind == "pdf" ? "doc.richtext" : "photo")
                                .foregroundStyle(Theme.accent)
                            Text(att.name).lineLimit(1)
                            Spacer()
                            Text(ByteCountFormatter.string(fromByteCount: Int64(att.data.count), countStyle: .file))
                                .font(.caption).foregroundStyle(Theme.textSoft)
                        }
                    }
                    .onDelete { attachments.remove(atOffsets: $0) }

                    Menu {
                        if UIImagePickerController.isSourceTypeAvailable(.camera) {
                            Button { showCamera = true } label: { Label("Take Photo", systemImage: "camera") }
                        }
                        Button { showPhotoPicker = true } label: { Label("Choose Photos", systemImage: "photo.on.rectangle") }
                        Button { showPDFImporter = true } label: { Label("Choose PDF", systemImage: "doc.richtext") }
                    } label: {
                        Label("Add PDF or photo", systemImage: "plus.circle.fill")
                    }
                } header: {
                    Text("Attachments")
                } footer: {
                    Text("At least one supporting PDF or photo is required. They're combined with this form into one file once the report is approved. Swipe left to remove one.")
                }

                if let errorText {
                    Section {
                        Label(errorText, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.danger)
                    }
                }

                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            Spacer()
                            if isSubmitting { ProgressView().padding(.trailing, 6) }
                            Text(isSubmitting ? "Submitting…" : "Submit Incident Report").bold()
                            Spacer()
                        }
                    }
                    .disabled(isSubmitting || !canSubmitPermission || (!projectId.isEmpty && !hasApprover))
                } footer: {
                    if !canSubmitPermission {
                        Text("You don't have permission to submit incident reports.")
                    }
                }
            }
            .navigationTitle("Incident Report")
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focused = false }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showActivity = true } label: { Label("My reports", systemImage: "clock.arrow.circlepath") }
                }
            }
            .task { await loadProjects() }
            .onChange(of: projectId) { _, newValue in
                Task { await loadApprover(newValue) }
            }
            .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 10, matching: .images)
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                Task { await addPhotos(items) }
            }
            .fileImporter(isPresented: $showPDFImporter, allowedContentTypes: [.pdf], allowsMultipleSelection: true) { result in
                if case .success(let urls) = result { addPDFs(urls) }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in
                    if let data = image.jpegData(compressionQuality: 0.85) {
                        addAttachment(name: "Photo-\(stamp()).jpg", data: data, type: "image/jpeg", kind: "image")
                    }
                }
                .ignoresSafeArea()
            }
            .alert("Incident report submitted", isPresented: $showSuccess) {
                Button("OK", role: .cancel) {}
                Button("View my reports") { showActivity = true }
            } message: {
                Text("Track its status on your Account Activity page.")
            }
            .navigationDestination(isPresented: $showActivity) {
                PortalWebScreen(page: PortalPage(title: "Account Activity", path: "/pages/account-activity.html"))
            }
        }
    }

    // MARK: Data

    private var todayDisplay: String {
        let iso = DateText.officeToday() // yyyy-MM-dd
        let parts = iso.split(separator: "-")
        return parts.count == 3 ? "\(parts[1])/\(parts[2])/\(parts[0])" : iso
    }

    private func loadProjects() async {
        guard projects.isEmpty else { return }
        projects = (try? await PortalAPI.pickerProjects()) ?? []
    }

    private func loadApprover(_ id: String) async {
        approver = nil
        guard !id.isEmpty else { return }
        approverLoading = true
        defer { approverLoading = false }
        approver = try? await PortalAPI.approverSetting(projectId: id)
    }

    // MARK: Attachments

    private func addAttachment(name: String, data: Data, type: String, kind: String) {
        guard data.count <= maxAttachmentBytes else {
            errorText = "\"\(name)\" is larger than 15MB and wasn't added."
            return
        }
        attachments.append(.init(name: name, data: data, contentType: type, kind: kind))
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        for (i, item) in items.enumerated() {
            guard let raw = try? await item.loadTransferable(type: Data.self) else { continue }
            let data = UIImage(data: raw)?.jpegData(compressionQuality: 0.85) ?? raw
            addAttachment(name: "Photo-\(stamp())-\(i + 1).jpg", data: data, type: "image/jpeg", kind: "image")
        }
        photoItems = []
    }

    private func addPDFs(_ urls: [URL]) {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let data = try? Data(contentsOf: url) {
                addAttachment(name: url.lastPathComponent, data: data, type: "application/pdf", kind: "pdf")
            }
        }
    }

    private func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        return f.string(from: Date())
    }

    // MARK: Submit (incident-report.js handleSubmit)

    /// Same rule as the web: a building must be ONE identifier (used for BC/VPO numbering).
    private func looksLikeMultipleValues(_ text: String) -> Bool {
        text.range(of: #"[,;/]|\band\b|&|\bmultiple\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private func parsePrice(_ raw: String) -> Double? {
        let cleaned = raw.filter { $0.isNumber || $0 == "." }
        return cleaned.isEmpty ? nil : Double(cleaned)
    }

    /// The web saves Reason / Change In Scope as rich-text HTML; turn plain
    /// text into simple, escaped paragraphs so it displays the same there.
    private func toHTML(_ text: String) -> String {
        let escaped = text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        return escaped
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { "<p>" + $0.replacingOccurrences(of: "\n", with: "<br>") + "</p>" }
            .joined()
    }

    private func submit() async {
        focused = false
        errorText = nil
        let trimmed = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
        let b = trimmed(building), u = trimmed(unitNumber), p = trimmed(person)
        let r = trimmed(reason), c = trimmed(changeInScope), w = trimmed(whoCaused)

        guard canSubmitPermission else { errorText = "You don't have permission to do this."; return }
        guard !projectId.isEmpty else { errorText = "Please select a project."; return }
        guard let price = parsePrice(priceText) else { errorText = "Please enter a price."; return }
        guard !b.isEmpty else { errorText = "Please enter the building."; return }
        guard !looksLikeMultipleValues(b) else {
            errorText = "Building must be a single identifier (e.g. \"1\") — it's used for BC/VPO numbering. Submit a separate report for each additional building."
            return
        }
        guard !u.isEmpty else { errorText = "Please enter the unit number."; return }
        guard !p.isEmpty else { errorText = "Please enter who's making this report."; return }
        guard !r.isEmpty else { errorText = "Please enter a reason for this report."; return }
        guard !w.isEmpty else { errorText = "Please enter who caused the issue."; return }
        guard !attachments.isEmpty else { errorText = "Please attach at least one supporting PDF or photo."; return }
        guard let profile = app.profile else { return }

        isSubmitting = true
        defer { isSubmitting = false }

        let report = NewIncidentReport(
            projectId: projectId,
            reportDate: DateText.officeToday(),
            price: price,
            buildings: b,
            unitNumbers: u,
            personMakingReport: p,
            reasonForReport: toHTML(r),
            changeInScope: c.isEmpty ? nil : toHTML(c),
            whoCausedIssue: w,
            submittedBy: profile.id,
            submittedByName: profile.displayName
        )

        do {
            try await PortalAPI.submitIncidentReport(
                report,
                attachments: attachments,
                projectName: projects.first { $0.id == projectId }?.name,
                submitterName: profile.displayName
            )
            resetForm()
            showSuccess = true
        } catch {
            let message = friendlyMessage(for: error, fallback: "")
            errorText = message.contains("No default approver is set up")
                ? message
                : "Something went wrong submitting this. Please try again."
        }
    }

    private func resetForm() {
        priceText = ""; building = ""; unitNumber = ""; person = ""
        reason = ""; changeInScope = ""; whoCaused = ""
        attachments = []
        // Project stays selected: people usually file several for the same job.
    }
}
