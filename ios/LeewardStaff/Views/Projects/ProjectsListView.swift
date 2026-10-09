import SwiftUI

/// pages/project-home.html (company-wide Project Overview): search, status
/// tabs, and a card per project. Archived projects only show under their own tab.
struct ProjectsListView: View {
    @State private var projects: [Project] = []
    @State private var search = ""
    @State private var tab: String = "all"
    @State private var isLoading = false
    @State private var errorText: String?

    private struct StatusTab: Identifiable {
        let key: String
        let label: String
        var id: String { key }
    }

    private var tabs: [StatusTab] {
        [StatusTab(key: "all", label: "All")] + ProjectStatus.allCases.map { StatusTab(key: $0.rawValue, label: $0.label) }
    }

    private func count(_ key: String) -> Int {
        key == "all"
            ? projects.filter { $0.statusKey != "archived" }.count
            : projects.filter { $0.statusKey == key }.count
    }

    private var filtered: [Project] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return projects.filter { p in
            if tab == "all" { if p.statusKey == "archived" { return false } }
            else if p.statusKey != tab { return false }
            guard !q.isEmpty else { return true }
            let haystack = [p.name, p.siteAddress, p.siteCity, p.siteState, p.gcName, p.projectManagerName, p.projectCode]
                .compactMap { $0 }.joined(separator: " ").lowercased()
            return haystack.contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(tabs) { t in
                                Button {
                                    withAnimation(.snappy) { tab = t.key }
                                } label: {
                                    HStack(spacing: 6) {
                                        Text(t.label)
                                        Text("\(count(t.key))").font(.caption.weight(.bold)).opacity(0.75)
                                    }
                                    .font(.subheadline.weight(.semibold))
                                    .padding(.horizontal, 14)
                                    .frame(height: 36)
                                    .foregroundStyle(tab == t.key ? .white : Theme.text)
                                    .background(tab == t.key ? Theme.accent : Theme.surface)
                                    .clipShape(Capsule())
                                    .overlay(Capsule().stroke(tab == t.key ? Color.clear : Theme.border))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                    }

                    if let errorText, projects.isEmpty {
                        LoadErrorView(message: errorText) { await load() }
                    } else if filtered.isEmpty && !isLoading {
                        ContentUnavailableView(
                            search.isEmpty ? "No projects here" : "No matches",
                            systemImage: "building.2",
                            description: Text(search.isEmpty ? "Nothing in this tab yet." : "Try a different search.")
                        )
                        .padding(.top, 40)
                    } else {
                        LazyVStack(spacing: 12) {
                            ForEach(filtered) { project in
                                NavigationLink(value: project) {
                                    ProjectCard(project: project)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                }
                .padding(.vertical, 8)
            }
            .background(Theme.background)
            .navigationTitle("Projects")
            .searchable(text: $search, prompt: "Search projects")
            .refreshable { await load() }
            .task { if projects.isEmpty { await load() } }
            .overlay { if isLoading && projects.isEmpty { ProgressView() } }
            .navigationDestination(for: Project.self) { project in
                ProjectDetailView(project: project)
            }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            projects = try await PortalAPI.projects()
            errorText = nil
        } catch {
            errorText = "Couldn't load projects. Pull down to try again."
        }
    }
}

/// The web's project card: cover photo, name, address, status, progress, due date.
struct ProjectCard: View {
    let project: Project

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CoverPhoto(urlString: project.coverPhotoUrl)
                .frame(height: 120)
                .clipped()

            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(project.displayName).font(.headline).foregroundStyle(Theme.text)
                        if !project.addressLine.isEmpty {
                            Text(project.addressLine).font(.caption).foregroundStyle(Theme.textSoft).lineLimit(2)
                        }
                    }
                    Spacer()
                    StatusPill(statusKey: project.statusKey)
                }

                HStack(spacing: 16) {
                    if let value = project.contractValue {
                        Metric(label: "Value", value: compactCurrency(value))
                    }
                    if let progress = project.progress {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Progress").font(.caption2.weight(.semibold)).foregroundStyle(Theme.textSoft)
                            ProgressView(value: min(max(progress, 0), 100), total: 100)
                                .frame(width: 70)
                            Text("\(Int(progress))%").font(.caption.weight(.semibold))
                        }
                    }
                    if let due = DateText.day(project.dueDate) {
                        Metric(label: "Due", value: due.formatted(.dateTime.month(.abbreviated).day().year()))
                    }
                }

                if let pm = project.projectManagerName, !pm.isEmpty {
                    Label(pm, systemImage: "person.crop.circle")
                        .font(.caption)
                        .foregroundStyle(Theme.textSoft)
                }
            }
            .padding(14)
        }
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.border))
    }
}

struct Metric: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(Theme.textSoft)
            Text(value).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
        }
    }
}

/// Cover photos are public URLs (project-covers bucket); placeholder when missing.
struct CoverPhoto: View {
    let urlString: String?
    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.accentSoft, Color(hex: 0xD6E3EE)], startPoint: .topLeading, endPoint: .bottomTrailing)
            if let urlString, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        Image(systemName: "building.2").font(.largeTitle).foregroundStyle(Theme.accent.opacity(0.4))
                    }
                }
            } else {
                Image(systemName: "building.2").font(.largeTitle).foregroundStyle(Theme.accent.opacity(0.4))
            }
        }
        .frame(maxWidth: .infinity)
    }
}
