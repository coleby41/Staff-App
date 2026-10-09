import SwiftUI

/// A project's contacts (project_contacts), grouped by type, with
/// tap-to-call and tap-to-email. Adding/editing stays on the web for now.
struct ProjectContactsView: View {
    let project: Project
    @State private var contacts: [ProjectContact] = []
    @State private var isLoading = false
    @State private var errorText: String?

    private struct ContactGroup: Identifiable {
        let type: ContactType
        let items: [ProjectContact]
        var id: String { type.rawValue }
    }

    private var grouped: [ContactGroup] {
        ContactType.allCases.compactMap { type in
            let items = contacts
                .filter { (ContactType(rawValue: $0.contactType ?? "") ?? .other) == type }
                .sorted { ($0.fullName ?? "") < ($1.fullName ?? "") }
            return items.isEmpty ? nil : ContactGroup(type: type, items: items)
        }
    }

    var body: some View {
        List {
            if let errorText {
                Text(errorText).foregroundStyle(Theme.danger)
            } else if contacts.isEmpty && !isLoading {
                ContentUnavailableView("No contacts yet", systemImage: "person.2",
                                       description: Text("Contacts added on the portal's Accounts / Contacts page show up here."))
            }
            ForEach(grouped) { group in
                Section {
                    ForEach(group.items) { ContactRow(contact: $0) }
                } header: {
                    Label(group.type.label, systemImage: group.type.symbol)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Contacts")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if isLoading && contacts.isEmpty { ProgressView() } }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            contacts = try await PortalAPI.contacts(projectId: project.id)
            errorText = nil
        } catch {
            errorText = "Couldn't load contacts."
        }
    }
}

private struct ContactRow: View {
    let contact: ProjectContact

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(contact.fullName ?? "Unnamed contact").font(.subheadline.weight(.semibold))
            let sub = [contact.title, contact.companyName].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
            if !sub.isEmpty {
                Text(sub).font(.caption).foregroundStyle(Theme.textSoft)
            }
            HStack(spacing: 10) {
                if let phone = contact.phone, !phone.isEmpty, let url = telURL(phone) {
                    Link(destination: url) {
                        Label(phone, systemImage: "phone.fill").font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                }
                if let email = contact.email, !email.isEmpty, let url = URL(string: "mailto:\(email)") {
                    Link(destination: url) {
                        Label("Email", systemImage: "envelope.fill").font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                }
            }
            if let notes = contact.notes, !notes.isEmpty {
                Text(notes).font(.caption).foregroundStyle(Theme.textSoft)
            }
        }
        .padding(.vertical, 4)
    }

    private func telURL(_ phone: String) -> URL? {
        let digits = phone.filter { $0.isNumber || $0 == "+" }
        return digits.isEmpty ? nil : URL(string: "tel:\(digits)")
    }
}
