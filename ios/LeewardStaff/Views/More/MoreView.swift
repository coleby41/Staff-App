import SwiftUI

/// The "More" menu (the 2A list from the phone mockup): who you are, every
/// other portal page you have access to (opened inside the app), Change
/// Password and Sign out. Visibility uses the same permission keys as the
/// web sidebar (js/nav-access.js NAV_ITEMS).
struct MoreView: View {
    @Environment(AppState.self) private var app
    @State private var showChangePassword = false
    @State private var confirmSignOut = false

    struct Item: Identifiable {
        let title: String
        let symbol: String
        let path: String
        let permission: String?
        var id: String { path }
    }

    private let pages: [Item] = [
        Item(title: "Staff Finance / Time Sheet", symbol: "clock", path: "/pages/timesheet.html", permission: "general.view_personal_finance"),
        Item(title: "Vendor Information", symbol: "building", path: "/pages/vendors.html", permission: "general.view_vendor_contacts"),
        Item(title: "Account Activity", symbol: "waveform.path.ecg", path: "/pages/account-activity.html", permission: nil),
        Item(title: "Payroll Tools", symbol: "banknote", path: "/pages/payroll-tools.html", permission: "general.view_payroll_tools"),
        Item(title: "Manage Employees", symbol: "person.2", path: "/pages/manage-employees.html", permission: "general.view_manage_employees"),
    ]

    private let docs: [Item] = [
        Item(title: "Excel Workbook Templates", symbol: "tablecells", path: "/pages/excel-workbook.html", permission: "general.view_excel_workbook_templates"),
        Item(title: "Form Templates", symbol: "doc.text", path: "/pages/form-template.html", permission: "general.view_form_templates"),
    ]

    private let itTools: [Item] = [
        Item(title: "Create Account", symbol: "person.badge.plus", path: "/pages/admin-users.html", permission: "general.create_staff_account"),
        Item(title: "Staff Users", symbol: "person.text.rectangle", path: "/pages/staff-users.html", permission: "general.view_staff_users"),
        Item(title: "Workgroups", symbol: "square.grid.2x2", path: "/pages/workgroups.html", permission: "general.manage_workgroups"),
    ]

    var body: some View {
        NavigationStack {
            List {
                if let profile = app.profile {
                    Section {
                        HStack(spacing: 12) {
                            BrandMark(size: 44, text: profile.initials)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(profile.displayName).font(.headline)
                                if !profile.workgroups.isEmpty {
                                    Text(profile.workgroups.joined(separator: " · "))
                                        .font(.subheadline).foregroundStyle(Theme.textSoft)
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                section("Pages", items: pages)
                section("Company Docs", items: docs)
                section("IT Tools", items: itTools)

                Section("Company") {
                    Link(destination: AppConfig.companySiteURL) {
                        HStack {
                            Label("Company Site", systemImage: "globe")
                            Spacer()
                            Image(systemName: "arrow.up.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
                        }
                    }
                    .foregroundStyle(Theme.text)
                    NavigationLink(value: PortalPage(title: "Notifications", path: "/pages/notifications.html")) {
                        Label("All Notifications (web)", systemImage: "bell")
                    }
                }

                Section {
                    Button { showChangePassword = true } label: {
                        Label("Change Password", systemImage: "lock")
                    }
                    .foregroundStyle(Theme.text)
                    Button(role: .destructive) { confirmSignOut = true } label: {
                        Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                } footer: {
                    Text("Leeward Staff \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("More")
            .navigationDestination(for: PortalPage.self) { PortalWebScreen(page: $0) }
            .sheet(isPresented: $showChangePassword) { ChangePasswordSheet() }
            .confirmationDialog("Sign out of Leeward Staff?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await app.signOut() } }
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, items: [Item]) -> some View {
        let visible = items.filter { app.can($0.permission) }
        if !visible.isEmpty {
            Section(title) {
                ForEach(visible) { item in
                    NavigationLink(value: PortalPage(title: item.title, path: item.path)) {
                        Label(item.title, systemImage: item.symbol)
                    }
                }
            }
        }
    }
}

/// change-password.js: current password, new (8+), confirm.
struct ChangePasswordSheet: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var new = ""
    @State private var confirm = ""
    @State private var isSaving = false
    @State private var errorText: String?
    @State private var done = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Current password", text: $current).textContentType(.password)
                    SecureField("New password (8+ characters)", text: $new).textContentType(.newPassword)
                    SecureField("Confirm new password", text: $confirm).textContentType(.newPassword)
                }
                if let errorText {
                    Section { Text(errorText).foregroundStyle(Theme.danger) }
                }
                if done {
                    Section { Label("Password updated.", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.success) }
                }
            }
            .navigationTitle("Change Password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(done ? "Done" : "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Update") { Task { await save() } }
                        .disabled(isSaving || done)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func save() async {
        errorText = nil
        guard !current.isEmpty else { errorText = "Enter your current password."; return }
        guard new.count >= 8 else { errorText = "Password must be at least 8 characters."; return }
        guard new == confirm else { errorText = "Passwords do not match."; return }
        guard new != current else { errorText = "New password must be different from your current password."; return }
        isSaving = true
        defer { isSaving = false }
        do {
            try await app.changePassword(current: current, new: new)
            done = true
            current = ""; new = ""; confirm = ""
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? friendlyMessage(for: error)
        }
    }
}
