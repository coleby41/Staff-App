import SwiftUI

@main
struct LeewardStaffApp: App {
    @State private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .tint(Theme.accent)
                .task { app.start() }
        }
    }
}

/// Picks the screen based on sign-in state.
struct RootView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .loading:
                LaunchView()
            case .signedOut:
                LoginView()
            case .mustResetPassword:
                ResetPasswordView()
            case .signedIn:
                MainTabView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: app.phase)
    }
}

struct LaunchView: View {
    var body: some View {
        VStack(spacing: 16) {
            BrandMark(size: 64)
            ProgressView()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }
}

/// The app's tab bar. Built with a standard SwiftUI TabView, so on iOS 26 it
/// automatically gets Apple's floating Liquid Glass look; on older iOS it's
/// the normal tab bar.
struct MainTabView: View {
    @Environment(AppState.self) private var app

    enum Tab: Hashable { case home, projects, tasks, report, more }
    @State private var selection: Tab = .home

    var body: some View {
        TabView(selection: $selection) {
            HomeView(selectTab: { selection = $0 })
                .tabItem { Label("Home", systemImage: "house") }
                .tag(Tab.home)

            if app.can("general.view_project_overview") {
                ProjectsListView()
                    .tabItem { Label("Projects", systemImage: "building.2") }
                    .tag(Tab.projects)
            }

            TasksView()
                .tabItem { Label("Tasks", systemImage: "checklist") }
                .tag(Tab.tasks)

            IncidentReportView()
                .tabItem { Label("Report", systemImage: "exclamationmark.bubble") }
                .tag(Tab.report)

            MoreView()
                .tabItem { Label("More", systemImage: "ellipsis") }
                .tag(Tab.more)
        }
    }
}
