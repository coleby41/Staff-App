import SwiftUI

/// pages/notifications.html: everything (read + unread), newest first,
/// 25 at a time, with All / Unread, Mark read, and Mark all as read.
struct NotificationsView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var items: [AppNotification] = []
    @State private var readIds: Set<String> = []
    @State private var offset = 0
    @State private var hasMore = true
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var filter: Filter = .all
    @State private var openPage: PortalPage?

    enum Filter: String, CaseIterable { case all = "All", unread = "Unread" }
    private let pageSize = 25

    private var shown: [AppNotification] {
        filter == .unread ? items.filter { !readIds.contains($0.id) } : items
    }
    private var unreadCount: Int { items.filter { !readIds.contains($0.id) }.count }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Show", selection: $filter) {
                        ForEach(Filter.allCases, id: \.self) { Text($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }

                if let errorText {
                    Text(errorText).foregroundStyle(Theme.danger)
                }

                if shown.isEmpty && !isLoading {
                    Text(filter == .unread ? "No unread notifications." : "No notifications yet.")
                        .foregroundStyle(Theme.textSoft)
                }

                ForEach(shown) { n in
                    NotificationRow(
                        notification: n,
                        isRead: readIds.contains(n.id),
                        openLink: { path in
                            Task { await markRead([n.id]) }
                            openPage = PortalPage(title: n.linkLabel ?? "Details", path: path)
                        }
                    )
                    .swipeActions(edge: .trailing) {
                        if !readIds.contains(n.id) {
                            Button("Mark read") { Task { await markRead([n.id]) } }
                                .tint(Theme.accent)
                        }
                    }
                }

                if hasMore && !items.isEmpty {
                    Button {
                        Task { await loadPage() }
                    } label: {
                        HStack { Spacer(); Text(isLoading ? "Loading…" : "Load more"); Spacer() }
                    }
                    .disabled(isLoading)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Mark all read") { Task { await markRead(items.map(\.id)) } }
                        .disabled(unreadCount == 0)
                }
            }
            .refreshable { await reload() }
            .task { if items.isEmpty { await loadPage() } }
            .navigationDestination(item: $openPage) { page in
                PortalWebScreen(page: page)
            }
        }
    }

    private func reload() async {
        items = []
        readIds = []
        offset = 0
        hasMore = true
        await loadPage()
    }

    private func loadPage() async {
        guard let staffId = app.profile?.id, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await PortalAPI.notifications(staffId: staffId, offset: offset, pageSize: pageSize)
            items += page.items
            readIds.formUnion(page.readIds)
            offset += page.items.count
            hasMore = page.items.count == pageSize
            errorText = nil
        } catch {
            errorText = "Couldn't load notifications."
        }
    }

    private func markRead(_ ids: [String]) async {
        guard let staffId = app.profile?.id else { return }
        let pending = ids.filter { !readIds.contains($0) }
        guard !pending.isEmpty else { return }
        do {
            try await PortalAPI.markNotificationsRead(ids: pending, staffId: staffId)
            readIds.formUnion(pending)
        } catch {
            errorText = friendlyMessage(for: error)
        }
    }
}

private struct NotificationRow: View {
    let notification: AppNotification
    let isRead: Bool
    let openLink: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(isRead ? Color.clear : Theme.accent)
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(notification.title ?? "Notification").font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(DateText.relative(notification.createdAt)).font(.caption).foregroundStyle(Theme.textSoft)
                }
                if let message = notification.message, !message.isEmpty {
                    Text(message).font(.subheadline).foregroundStyle(Theme.textSoft)
                }
                if let link = notification.linkUrl, !link.isEmpty {
                    Button(notification.linkLabel ?? "View it here") { openLink(link) }
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.borderless)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
