import SwiftUI
import PhotosUI
import QuickLook
import UniformTypeIdentifiers

/// pages/project-files.html ("All Files"): the fixed folder tree, the files in
/// each folder, open/share any file, and upload photos or documents into the
/// folder you're in. Rename/delete stay on the web for now.
struct ProjectFilesView: View {
    let project: Project
    @State private var files: [ProjectFile] = []
    @State private var isLoading = false
    @State private var errorText: String?

    var body: some View {
        List {
            if let errorText {
                Text(errorText).foregroundStyle(Theme.danger)
            }
            Section {
                ForEach(FileCategories.all) { category in
                    NavigationLink {
                        CategoryView(project: project, category: category, files: $files)
                    } label: {
                        FolderRow(
                            title: "\(category.number) — \(category.label)",
                            count: files.filter { $0.category == category.key }.count
                        )
                    }
                }
            } footer: {
                Text("\(files.count) file\(files.count == 1 ? "" : "s") in this project")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Project Files")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if isLoading && files.isEmpty { ProgressView() } }
        .refreshable { await load() }
        .task { if files.isEmpty { await load() } }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            files = try await PortalAPI.projectFiles(projectId: project.id)
            errorText = nil
        } catch {
            errorText = "Couldn't load this project's files."
        }
    }
}

private struct FolderRow: View {
    let title: String
    let count: Int
    var body: some View {
        HStack {
            Image(systemName: "folder.fill").foregroundStyle(Theme.accent)
            Text(title).lineLimit(2)
            Spacer()
            if count > 0 {
                Text("\(count)").font(.caption.weight(.semibold)).foregroundStyle(Theme.textSoft)
            }
        }
    }
}

private struct CategoryView: View {
    let project: Project
    let category: FileCategory
    @Binding var files: [ProjectFile]

    var body: some View {
        List {
            ForEach(category.subfolders) { sub in
                NavigationLink {
                    if sub.children.isEmpty {
                        FolderFilesView(project: project, category: category, subfolder: sub, subSubfolder: nil, files: $files)
                    } else {
                        SubfolderChildrenView(project: project, category: category, subfolder: sub, files: $files)
                    }
                } label: {
                    FolderRow(title: sub.label,
                              count: files.filter { $0.category == category.key && $0.subfolder == sub.key }.count)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(category.label)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// "A folder inside a folder" (Back Charges - BC, VPO): pick signed / unsigned.
private struct SubfolderChildrenView: View {
    let project: Project
    let category: FileCategory
    let subfolder: FileSubfolder
    @Binding var files: [ProjectFile]

    var body: some View {
        List {
            ForEach(subfolder.children) { child in
                NavigationLink {
                    FolderFilesView(project: project, category: category, subfolder: subfolder, subSubfolder: child, files: $files)
                } label: {
                    FolderRow(title: child.label, count: files.filter {
                        $0.category == category.key && $0.subfolder == subfolder.key && $0.subSubfolder == child.key
                    }.count)
                }
            }
            let loose = files.filter { $0.category == category.key && $0.subfolder == subfolder.key && ($0.subSubfolder ?? "").isEmpty }
            if !loose.isEmpty {
                Section("Filed directly here") {
                    ForEach(loose) { FileRow(file: $0) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(subfolder.label)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The files in one (leaf) folder, plus upload.
private struct FolderFilesView: View {
    @Environment(AppState.self) private var app
    let project: Project
    let category: FileCategory
    let subfolder: FileSubfolder
    let subSubfolder: FileSubfolder?
    @Binding var files: [ProjectFile]

    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var showCamera = false
    @State private var uploadStatus: String?
    @State private var errorText: String?

    private var folderFiles: [ProjectFile] {
        files.filter {
            $0.category == category.key && $0.subfolder == subfolder.key && ($0.subSubfolder ?? "") == (subSubfolder?.key ?? "")
        }
    }

    var body: some View {
        List {
            if let uploadStatus {
                HStack { ProgressView(); Text(uploadStatus).foregroundStyle(Theme.textSoft) }
            }
            if let errorText {
                Text(errorText).foregroundStyle(Theme.danger)
            }
            if folderFiles.isEmpty {
                ContentUnavailableView("No files yet", systemImage: "doc",
                                       description: Text("Tap + to add photos or documents to this folder."))
            }
            ForEach(folderFiles) { FileRow(file: $0) }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(subSubfolder?.label ?? subfolder.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { showCamera = true } label: { Label("Take Photo", systemImage: "camera") }
                    }
                    Button { showPhotoPicker = true } label: { Label("Choose Photos", systemImage: "photo.on.rectangle") }
                    Button { showFileImporter = true } label: { Label("Choose Files", systemImage: "doc") }
                } label: {
                    Label("Add", systemImage: "plus")
                }
                .disabled(uploadStatus != nil)
            }
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 20, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await uploadPhotos(items) }
        }
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                Task { await uploadFiles(urls) }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                guard let data = image.jpegData(compressionQuality: 0.85) else { return }
                Task { await upload([(name: "Photo-\(fileStamp()).jpg", data: data, type: "image/jpeg")]) }
            }
            .ignoresSafeArea()
        }
    }

    private func uploadPhotos(_ items: [PhotosPickerItem]) async {
        var picked: [(name: String, data: Data, type: String)] = []
        for (i, item) in items.enumerated() {
            guard let raw = try? await item.loadTransferable(type: Data.self) else { continue }
            // Normalize to JPEG (HEIC photos don't open everywhere on the web).
            let data = UIImage(data: raw)?.jpegData(compressionQuality: 0.85) ?? raw
            picked.append((name: "Photo-\(fileStamp())-\(i + 1).jpg", data: data, type: "image/jpeg"))
        }
        photoItems = []
        await upload(picked)
    }

    private func uploadFiles(_ urls: [URL]) async {
        var picked: [(name: String, data: Data, type: String)] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            picked.append((name: url.lastPathComponent, data: data, type: type))
        }
        await upload(picked)
    }

    private func upload(_ items: [(name: String, data: Data, type: String)]) async {
        guard !items.isEmpty else { return }
        errorText = nil
        var failed: [String] = []
        for (i, item) in items.enumerated() {
            uploadStatus = items.count > 1 ? "Uploading \(i + 1) of \(items.count)…" : "Uploading…"
            do {
                let row = try await PortalAPI.uploadProjectFile(
                    projectId: project.id, category: category.key, subfolder: subfolder.key,
                    subSubfolder: subSubfolder?.key, fileName: item.name, data: item.data,
                    contentType: item.type, uploadedByName: app.profile?.displayName ?? "Staff"
                )
                files.insert(row, at: 0)
            } catch {
                failed.append(item.name)
            }
        }
        uploadStatus = nil
        if !failed.isEmpty {
            errorText = "Couldn't upload: \(failed.joined(separator: ", "))"
        }
    }

    private func fileStamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        return f.string(from: Date())
    }
}

/// One file: tap to open in Quick Look (PDF, images, Office docs), with share.
private struct FileRow: View {
    let file: ProjectFile
    @State private var previewURL: URL?
    @State private var isOpening = false
    @State private var errorText: String?

    private var symbol: String {
        let ext = (file.fileName as NSString).pathExtension.lowercased()
        switch ext {
        case "pdf": return "doc.richtext"
        case "jpg", "jpeg", "png", "heic", "gif", "webp": return "photo"
        case "xls", "xlsx", "csv": return "tablecells"
        case "doc", "docx": return "doc.text"
        default: return "doc"
        }
    }

    var body: some View {
        Button {
            Task { await open() }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol).foregroundStyle(Theme.accent).frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(file.fileName).font(.subheadline).foregroundStyle(Theme.text).lineLimit(2)
                    let added = [file.uploadedByName, DateText.timestamp(file.createdAt)?.formatted(.dateTime.month(.abbreviated).day().year())]
                        .compactMap { $0 }.joined(separator: " · ")
                    if !added.isEmpty {
                        Text(added).font(.caption).foregroundStyle(Theme.textSoft)
                    }
                    if file.source == "form_submission" {
                        Text("Form: \(file.formSubmissions?.formTitle ?? "submission")")
                            .font(.caption2.weight(.semibold)).foregroundStyle(Theme.accent)
                    }
                    if let errorText {
                        Text(errorText).font(.caption).foregroundStyle(Theme.danger)
                    }
                }
                Spacer()
                if isOpening { ProgressView() }
            }
        }
        .disabled(isOpening)
        .quickLookPreview($previewURL)
    }

    private func open() async {
        isOpening = true
        defer { isOpening = false }
        do {
            previewURL = try await PortalAPI.downloadToTemp(file)
            errorText = nil
        } catch {
            errorText = "Couldn't open this file."
        }
    }
}

/// UIKit camera wrapped for SwiftUI.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
