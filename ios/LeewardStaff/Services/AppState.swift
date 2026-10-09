import Foundation
import Observation
import Supabase

/// Who's signed in, and what they're allowed to see.
/// Mirrors js/supabase-auth.js + js/login.js + js/permissions.js.
@MainActor
@Observable
final class AppState {
    enum Phase: Equatable {
        case loading
        case signedOut
        case mustResetPassword
        case signedIn
    }

    private(set) var phase: Phase = .loading
    private(set) var profile: StaffProfile?
    let permissions = PermissionStore()

    /// Bumped whenever the session changes, so open web views re-sync tokens.
    private(set) var sessionVersion = 0

    private var listenTask: Task<Void, Never>?

    func start() {
        guard listenTask == nil else { return }
        listenTask = Task { [weak self] in
            for await (event, session) in supabase.auth.authStateChanges {
                guard let self else { return }
                await self.handle(event: event, session: session)
            }
        }
    }

    private func handle(event: AuthChangeEvent, session: Session?) async {
        sessionVersion += 1

        if event == .signedOut || session == nil {
            if event == .initialSession || event == .signedOut || phase != .loading {
                profile = nil
                permissions.reset()
                phase = .signedOut
            }
            return
        }

        guard let session else { return }

        // A stored session can be expired on launch; `auth.session` refreshes it.
        // If that fails (refresh token revoked, signed out elsewhere) show login.
        if event == .initialSession, session.expiresAt < Date().timeIntervalSince1970 + 30 {
            do {
                _ = try await supabase.auth.session
            } catch {
                profile = nil
                phase = .signedOut
            }
            return // the refresh fires .tokenRefreshed, which lands back here
        }

        if profile == nil || profile?.authUserId?.lowercased() != session.user.id.uuidString.lowercased() {
            await loadProfile(authUserId: session.user.id)
        }
    }

    /// supabase-auth.js loadProfileForSession(): the staff_users row for this login.
    private func loadProfile(authUserId: UUID) async {
        do {
            let rows: [StaffProfile] = try await supabase
                .from("staff_users")
                .select(StaffProfile.selectColumns)
                .eq("auth_user_id", value: authUserId)
                .limit(1)
                .execute()
                .value

            guard let row = rows.first, row.active != false else {
                // Signed in, but no matching (or an inactive) staff record.
                try? await supabase.auth.signOut()
                profile = nil
                phase = .signedOut
                return
            }

            profile = row
            await permissions.load()
            phase = row.mustResetPassword == true ? .mustResetPassword : .signedIn
        } catch {
            // Can't reach the server: keep any profile we already had.
            if profile == nil { phase = .signedOut }
        }
    }

    // MARK: - Sign in / out

    enum SignInError: LocalizedError {
        case badCredentials, notSetUp, deactivated, network
        var errorDescription: String? {
            switch self {
            case .badCredentials: return "Incorrect username or password."
            case .notSetUp: return "This account is not set up correctly. Please contact the IT department."
            case .deactivated: return "This account has been deactivated. Please contact the IT department for assistance."
            case .network: return "Unable to reach the server. Try again."
            }
        }
    }

    /// Same two-step sign-in as the web: username -> auth email via the
    /// get_login_email RPC, then a real password sign-in.
    func signIn(username: String, password: String) async throws {
        let email: String?
        do {
            email = try await supabase
                .rpc("get_login_email", params: ["p_username": username])
                .execute()
                .value
        } catch {
            if error is URLError { throw SignInError.network }
            throw SignInError.badCredentials
        }
        guard let email, !email.isEmpty else { throw SignInError.badCredentials }

        let session: Session
        do {
            session = try await supabase.auth.signIn(email: email, password: password)
        } catch {
            if error is URLError { throw SignInError.network }
            throw SignInError.badCredentials
        }

        // Check the staff record before letting them in (login.js does the same).
        let rows: [StaffProfile] = try await supabase
            .from("staff_users")
            .select(StaffProfile.selectColumns)
            .eq("auth_user_id", value: session.user.id)
            .limit(1)
            .execute()
            .value

        guard let row = rows.first else {
            try? await supabase.auth.signOut()
            throw SignInError.notSetUp
        }
        if row.active == false {
            try? await supabase.auth.signOut()
            throw SignInError.deactivated
        }

        profile = row
        await permissions.load()
        phase = row.mustResetPassword == true ? .mustResetPassword : .signedIn
    }

    /// The forced first-login reset (login.js resetForm).
    func setNewPassword(_ newPassword: String) async throws {
        try await supabase.auth.update(user: UserAttributes(password: newPassword))
        try await supabase.rpc("clear_must_reset_password").execute()
        if let id = profile?.authUserId, let uuid = UUID(uuidString: id) {
            await loadProfile(authUserId: uuid)
        } else {
            phase = .signedIn
        }
    }

    /// change-password.js: verify the current password by signing in again,
    /// then set the new one.
    func changePassword(current: String, new newPassword: String) async throws {
        guard let email = supabase.auth.currentUser?.email else { throw SignInError.notSetUp }
        do {
            try await supabase.auth.signIn(email: email, password: current)
        } catch {
            throw ChangePasswordError.wrongCurrent
        }
        try await supabase.auth.update(user: UserAttributes(password: newPassword))
    }

    enum ChangePasswordError: LocalizedError {
        case wrongCurrent
        var errorDescription: String? { "Your current password is incorrect." }
    }

    func signOut() async {
        try? await supabase.auth.signOut()
        profile = nil
        permissions.reset()
        phase = .signedOut
    }

    /// The in-app web view signed out (or got signed out): follow it.
    func handleWebSignOut() async {
        await signOut()
    }

    func can(_ permissionKey: String?) -> Bool {
        guard let permissionKey else { return true }
        return permissions.has(permissionKey, profile: profile)
    }
}

/// js/permissions.js, trimmed to what the app needs.
/// Fails OPEN on purpose (same as the web): if the permission tables can't
/// be read, every check answers true so nobody gets locked out.
@MainActor
@Observable
final class PermissionStore {
    private var byGroup: [String: Set<String>] = [:]
    private(set) var loaded = false
    private var loadFailed = false

    /// Extra permissions anyone with staff_users.role = Manager gets.
    private let managerBonus: Set<String> = [
        "general.view_manage_employees",
        "manager.view_team_timesheets",
        "manager.approve_reject_timesheets",
        "manager.comment_on_timesheet",
    ]

    func reset() {
        byGroup = [:]
        loaded = false
        loadFailed = false
    }

    func load() async {
        do {
            async let groupsReq: [WorkgroupRow] = supabase.from("workgroups").select("id, name").execute().value
            async let rowsReq: [WorkgroupPermissionRow] = supabase.from("workgroup_permissions").select("workgroup_id, permission_key").execute().value
            let (groups, rows) = try await (groupsReq, rowsReq)

            let idToName = Dictionary(uniqueKeysWithValues: groups.map {
                ($0.id, ($0.name ?? "").trimmingCharacters(in: .whitespaces).lowercased())
            })
            var map: [String: Set<String>] = [:]
            for row in rows {
                guard let name = idToName[row.workgroupId], !name.isEmpty else { continue }
                map[name, default: []].insert(row.permissionKey)
            }
            byGroup = map
            loadFailed = false
            loaded = true
        } catch {
            loadFailed = true
            loaded = true
        }
    }

    func has(_ key: String, profile: StaffProfile?) -> Bool {
        if loadFailed || !loaded { return true }
        guard let profile else { return false }
        if profile.isInGroup("super admin") { return true }
        if profile.isManager && managerBonus.contains(key) { return true }
        return profile.normalizedGroups.contains { byGroup[$0]?.contains(key) == true }
    }
}
