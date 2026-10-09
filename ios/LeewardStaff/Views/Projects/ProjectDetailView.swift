import SwiftUI

/// One project: overview at the top, then its pages. Files and Contacts are
/// native; the rest (To-Do, Form Logs, Timeline, Accounting, full details)
/// open from the portal inside the app.
struct ProjectDetailView: View {
    let project: Project
    @State private var current: Project?
    @State private var openPage: PortalPage?

    private var p: Project { current ?? project }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    CoverPhoto(urlString: p.coverPhotoUrl)
                        .frame(height: 150)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(p.displayName).font(.title2.bold())
                            if let code = p.projectCode, !code.isEmpty {
                                Text(code).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSoft)
                            }
                        }
                        Spacer()
                        StatusPill(statusKey: p.statusKey)
                    }

                    HStack(spacing: 20) {
                        if let value = p.contractValue {
                            Metric(label: "Contract value", value: compactCurrency(value))
                        }
                        if let progress = p.progress {
                            Metric(label: "Progress", value: "\(Int(progress))%")
                        }
                        if let due = DateText.day(p.dueDate) {
                            Metric(label: "Due", value: due.formatted(.dateTime.month(.abbreviated).day().year()))
                        }
                    }
                }
                .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
            }

            Section("Details") {
                if !p.addressLine.isEmpty {
                    Button {
                        openInMaps()
                    } label: {
                        DetailRow(icon: "mappin.and.ellipse", label: "Site", value: [p.siteAddress, p.siteCity, p.siteState, p.siteZip].compactMap { $0 }.joined(separator: ", "))
                    }
                    .buttonStyle(.plain)
                }
                if let pm = p.projectManagerName, !pm.isEmpty {
                    DetailRow(icon: "person.crop.circle", label: "Project manager", value: pm)
                }
                if let gc = p.gcName, !gc.isEmpty {
                    DetailRow(icon: "building.2", label: "General contractor", value: gc)
                }
            }

            Section("Project") {
                NavigationLink {
                    ProjectFilesView(project: p)
                } label: {
                    Label("Project Files", systemImage: "folder")
                }
                NavigationLink {
                    ProjectContactsView(project: p)
                } label: {
                    Label("Contacts", systemImage: "person.2")
                }
                webRow("To-Do", icon: "checklist", path: "/pages/project-todo.html")
                webRow("Form Logs", icon: "list.clipboard", path: "/pages/project-form-logs.html")
                webRow("Accounts / Contacts (full)", icon: "rectangle.stack.person.crop", path: "/pages/project-accounts.html")
                webRow("Full Overview", icon: "doc.text.magnifyingglass", path: "/pages/projects.html")
            }

            Section {
                HStack {
                    Label("Project Timeline", systemImage: "calendar.day.timeline.left")
                    Spacer()
                    Text("Desktop only").font(.caption.weight(.semibold)).foregroundStyle(Theme.warning)
                }
                .foregroundStyle(Theme.textSoft)
            } footer: {
                Text("The schedule is a drag-and-drop Gantt chart. Open it on a laptop or desktop.")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(p.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $openPage) { PortalWebScreen(page: $0) }
        .refreshable { current = (try? await PortalAPI.project(id: project.id)) ?? current }
    }

    private func webRow(_ title: String, icon: String, path: String) -> some View {
        Button {
            openPage = PortalPage(title: title, path: "\(path)?id=\(p.id)")
        } label: {
            HStack {
                Label(title, systemImage: icon)
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
            }
        }
        .foregroundStyle(Theme.text)
    }

    private func openInMaps() {
        let query = [p.siteAddress, p.siteCity, p.siteState, p.siteZip].compactMap { $0 }.joined(separator: ", ")
        var components = URLComponents(string: "https://maps.apple.com/")!
        components.queryItems = [URLQueryItem(name: "q", value: query)]
        if let url = components.url { UIApplication.shared.open(url) }
    }
}

struct DetailRow: View {
    let icon: String
    let label: String
    let value: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(Theme.accent).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.caption).foregroundStyle(Theme.textSoft)
                Text(value).font(.subheadline)
            }
        }
    }
}
