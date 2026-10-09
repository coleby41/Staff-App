import SwiftUI

/// pages/login.html, natively. Username + password (not email), same as the web.
struct LoginView: View {
    @Environment(AppState.self) private var app
    @State private var username = ""
    @State private var password = ""
    @State private var isWorking = false
    @State private var errorText: String?
    @FocusState private var focus: Field?

    enum Field { case username, password }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 12) {
                    BrandMark(size: 48)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("The Leeward Group").font(.headline)
                        Text("Internal staff portal").font(.subheadline).foregroundStyle(Theme.textSoft)
                    }
                }
                .padding(.top, 48)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Welcome back").font(.largeTitle.bold())
                    Text("Sign in to access project updates, field support tools, and internal operations.")
                        .foregroundStyle(Theme.textSoft)
                }

                VStack(spacing: 14) {
                    LabeledField(title: "Username") {
                        TextField("Enter your username", text: $username)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.next)
                            .focused($focus, equals: .username)
                            .onSubmit { focus = .password }
                    }
                    LabeledField(title: "Password") {
                        SecureField("Enter your password", text: $password)
                            .textContentType(.password)
                            .submitLabel(.go)
                            .focused($focus, equals: .password)
                            .onSubmit { Task { await submit() } }
                    }
                }

                if let errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(Theme.danger)
                }

                Button {
                    Task { await submit() }
                } label: {
                    HStack {
                        if isWorking { ProgressView().tint(.white) }
                        Text(isWorking ? "Signing in…" : "Sign in").bold()
                    }
                    .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isWorking)

                Text("New accounts are created by IT administrators only.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSoft)
                    .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.background)
    }

    private func submit() async {
        let user = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let pass = password.trimmingCharacters(in: .whitespacesAndNewlines) // login.js trims too
        guard !user.isEmpty, !pass.isEmpty else {
            errorText = "Please enter your username and password."
            return
        }
        isWorking = true
        errorText = nil
        defer { isWorking = false }
        do {
            try await app.signIn(username: user, password: pass)
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription ?? "Unable to sign in. Try again."
        }
    }
}

/// First sign-in with a temporary password (or after IT resets it).
struct ResetPasswordView: View {
    @Environment(AppState.self) private var app
    @State private var newPassword = ""
    @State private var confirm = ""
    @State private var isWorking = false
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                BrandMark(size: 48).padding(.top, 48)
                Text("Set your password").font(.largeTitle.bold())
                Text("You're signed in with a temporary password. Choose a new one to continue.")
                    .foregroundStyle(Theme.textSoft)

                LabeledField(title: "New password") {
                    SecureField("At least 8 characters", text: $newPassword).textContentType(.newPassword)
                }
                LabeledField(title: "Confirm new password") {
                    SecureField("Type it again", text: $confirm).textContentType(.newPassword)
                }

                if let errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(Theme.danger)
                }

                Button {
                    Task { await submit() }
                } label: {
                    Text(isWorking ? "Saving…" : "Save and continue").bold()
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isWorking)

                Button("Sign out") { Task { await app.signOut() } }
                    .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background)
    }

    private func submit() async {
        guard newPassword.count >= 8 else { errorText = "Password must be at least 8 characters."; return }
        guard newPassword == confirm else { errorText = "Passwords do not match."; return }
        isWorking = true
        errorText = nil
        defer { isWorking = false }
        do {
            try await app.setNewPassword(newPassword)
        } catch {
            errorText = friendlyMessage(for: error, fallback: "Unable to set your new password. Try again.")
        }
    }
}
