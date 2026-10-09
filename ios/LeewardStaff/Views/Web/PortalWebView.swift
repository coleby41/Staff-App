import SwiftUI
import WebKit
import Supabase

/// A portal page that isn't native yet, shown inside the app.
struct PortalPage: Hashable, Identifiable {
    let title: String
    let path: String
    var id: String { path }
}

/// Wraps PortalWebView with a title, a loading spinner, and an error state.
struct PortalWebScreen: View {
    let page: PortalPage
    @Environment(AppState.self) private var app
    @State private var isLoading = true
    @State private var errorText: String?
    @State private var reloadToken = 0

    var body: some View {
        ZStack {
            PortalWebView(
                url: AppConfig.portalURL(page.path),
                reloadToken: reloadToken,
                sessionVersion: app.sessionVersion, // read here so SwiftUI re-runs updateUIView when tokens change
                app: app,
                onLoadingChange: { isLoading = $0 },
                onError: { errorText = $0 }
            )
            .ignoresSafeArea(edges: .bottom)

            if isLoading && errorText == nil {
                ProgressView().controlSize(.large)
            }

            if let errorText {
                ContentUnavailableView {
                    Label("Couldn't open this page", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(errorText)
                } actions: {
                    Button("Try Again") {
                        self.errorText = nil
                        reloadToken += 1
                    }
                    .buttonStyle(.borderedProminent)
                }
                .background(Theme.background)
            }
        }
        .background(Theme.background)
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { reloadToken += 1 } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    Link(destination: AppConfig.portalURL(page.path)) {
                        Label("Open in Safari", systemImage: "safari")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
    }
}

/// WKWebView that opens portal pages already signed in.
///
/// How the sign-in hand-off works:
/// - Before each page loads, a script writes the app's current Supabase
///   session into localStorage under supabase-js's key
///   ("sb-<project-ref>-auth-token"), so the page's own auth-guard.js finds
///   a valid session and doesn't bounce to the login page.
/// - Supabase rotates refresh tokens, so two clients sharing one session must
///   stay in sync or the next refresh signs both out. The script watches for
///   supabase-js saving a refreshed session and hands the new tokens back to
///   the app (setSession), and the app's newer tokens are written back into
///   the page on the next load.
/// - The site's own header, sidebar and phone tab bar are hidden in here; the
///   app provides the navigation.
struct PortalWebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    let sessionVersion: Int
    let app: AppState
    let onLoadingChange: (Bool) -> Void
    let onError: (String?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(app: app, onLoadingChange: onLoadingChange, onError: onError)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.add(WeakScriptHandler(context.coordinator), name: Coordinator.messageName)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = UIColor(Theme.background)
        webView.scrollView.backgroundColor = UIColor(Theme.background)

        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.pullToRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        context.coordinator.webView = webView
        context.coordinator.lastReloadToken = reloadToken
        context.coordinator.lastSessionVersion = sessionVersion
        context.coordinator.load(url)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        let coordinator = context.coordinator
        if coordinator.lastReloadToken != reloadToken {
            coordinator.lastReloadToken = reloadToken
            coordinator.load(url)
        } else if coordinator.lastSessionVersion != sessionVersion {
            // Tokens changed (refresh / hand-off): make sure the NEXT page load
            // gets the newest ones. No reload needed for the current page.
            coordinator.lastSessionVersion = sessionVersion
            Task {
                await coordinator.installScripts()
                coordinator.pushSessionToOpenPage()
            }
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.messageName)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        static let messageName = "portalAuth"

        let app: AppState
        let onLoadingChange: (Bool) -> Void
        let onError: (String?) -> Void
        weak var webView: WKWebView?
        var lastReloadToken = 0
        var lastSessionVersion = 0
        private var targetURL: URL?
        private var loginBounceCount = 0

        private var portalHost: String? { AppConfig.portalBaseURL.host?.lowercased() }
        private var storageKey: String { "sb-\(AppConfig.supabaseProjectRef)-auth-token" }

        init(app: AppState, onLoadingChange: @escaping (Bool) -> Void, onError: @escaping (String?) -> Void) {
            self.app = app
            self.onLoadingChange = onLoadingChange
            self.onError = onError
        }

        func load(_ url: URL) {
            targetURL = url
            // State updates happen inside the Task (after SwiftUI's current
            // update pass), never synchronously from make/updateUIView.
            Task {
                onError(nil)
                onLoadingChange(true)
                guard await installScripts() else {
                    onLoadingChange(false)
                    onError("You've been signed out. Please sign in again.")
                    return
                }
                webView?.load(URLRequest(url: url))
            }
        }

        @objc func pullToRefresh(_ sender: UIRefreshControl) {
            Task {
                await installScripts()
                webView?.reload()
                sender.endRefreshing()
            }
        }

        /// (Re)writes the start-of-page script with the app's current session.
        @discardableResult
        func installScripts() async -> Bool {
            guard let webView else { return false }
            // `auth.session` refreshes first if the access token is about to expire.
            guard let session = try? await supabase.auth.session else { return false }

            let controller = webView.configuration.userContentController
            controller.removeAllUserScripts()
            controller.addUserScript(WKUserScript(
                source: Self.bootstrapScript(session: session, profile: app.profile, storageKey: storageKey),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
            return true
        }

        /// Writes the app's current tokens into the page that's already open.
        /// Supabase rotates refresh tokens, so if the app refreshed in the
        /// background, the open page must stop using the old one right away
        /// (supabase-js reads the session from localStorage each time).
        func pushSessionToOpenPage() {
            guard let webView, let session = supabase.auth.currentSession else { return }
            let js = "try { localStorage.setItem(\(Self.jsString(storageKey)), \(Self.jsString(Self.sessionJSON(session)))); } catch (e) {}"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        // MARK: Script

        private static func jsString(_ value: String) -> String {
            // JSON-encoding a String yields a valid, safely quoted JS string literal.
            let data = (try? JSONEncoder().encode(value)) ?? Data("\"\"".utf8)
            return String(decoding: data, as: UTF8.self)
        }

        private static func sessionJSON(_ session: Session) -> String {
            let user: [String: Any] = [
                "id": session.user.id.uuidString.lowercased(),
                "email": session.user.email ?? "",
                "aud": "authenticated",
                "role": "authenticated",
                "app_metadata": [String: Any](),
                "user_metadata": [String: Any](),
            ]
            let dict: [String: Any] = [
                "access_token": session.accessToken,
                "token_type": session.tokenType,
                "expires_in": Int(session.expiresIn),
                "expires_at": Int(session.expiresAt),
                "refresh_token": session.refreshToken,
                "user": user,
            ]
            let data = (try? JSONSerialization.data(withJSONObject: dict)) ?? Data("{}".utf8)
            return String(decoding: data, as: UTF8.self)
        }

        private static func bootstrapScript(session: Session, profile: StaffProfile?, storageKey: String) -> String {
            let profileJSON = profile.flatMap { try? JSONEncoder().encode($0) }.map { String(decoding: $0, as: UTF8.self) } ?? "null"
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = AppConfig.officeTimeZone
            formatter.dateFormat = "yyyy-MM-dd"
            let officeToday = formatter.string(from: Date())

            return """
            (function () {
              try {
                var KEY = \(jsString(storageKey));
                localStorage.setItem(KEY, \(jsString(sessionJSON(session))));
                var profile = \(jsString(profileJSON));
                if (profile !== "null") {
                  localStorage.setItem("staffProfile", profile);
                  var p = JSON.parse(profile);
                  // Skip the once-a-day Good Morning redirect inside the app.
                  if (p && p.id) localStorage.setItem("morningSeen:" + p.id, \(jsString(officeToday)));
                }

                // Hand refreshed / cleared sessions back to the app.
                var setItem = Storage.prototype.setItem;
                var removeItem = Storage.prototype.removeItem;
                function post(msg) { try { window.webkit.messageHandlers.\(messageName).postMessage(msg); } catch (e) {} }
                Storage.prototype.setItem = function (k, v) {
                  setItem.apply(this, arguments);
                  if (this === window.localStorage && k === KEY) post({ type: "session", value: String(v) });
                };
                Storage.prototype.removeItem = function (k) {
                  removeItem.apply(this, arguments);
                  if (this === window.localStorage && k === KEY) post({ type: "signedOut" });
                };
              } catch (e) {}

              // Hide the site's own header / sidebar / tab bar. The page's root
              // element may not exist yet this early, so wait for it if needed.
              function addAppChrome() {
                var root = document.documentElement;
                if (!root) return false;
                root.classList.add("in-ios-app");
                var style = document.createElement("style");
                style.textContent = \(jsString(Self.inAppCSS));
                (document.head || root).appendChild(style);
                return true;
              }
              try {
                if (!addAppChrome()) {
                  var watcher = new MutationObserver(function () { if (addAppChrome()) watcher.disconnect(); });
                  watcher.observe(document, { childList: true, subtree: true });
                }
              } catch (e) {}
            })();
            """
        }

        /// The app supplies navigation, so hide the site's own chrome.
        private static let inAppCSS = """
        html.in-ios-app .header,
        html.in-ios-app .sidebar,
        html.in-ios-app .sidebar-backdrop,
        html.in-ios-app .sidebar-collapse-toggle,
        html.in-ios-app .mobile-tabbar,
        html.in-ios-app .mobile-sheet,
        html.in-ios-app .mobile-sheet-scrim { display: none !important; }
        html.in-ios-app .main-content,
        html.in-ios-app .main-content.expanded {
          margin-top: 0 !important;
          margin-left: 0 !important;
          padding-top: 14px !important;
          padding-bottom: 40px !important;
        }
        """

        // MARK: WKScriptMessageHandler

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "session":
                guard
                    let raw = body["value"] as? String,
                    let data = raw.data(using: .utf8),
                    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let access = json["access_token"] as? String,
                    let refresh = json["refresh_token"] as? String
                else { return }
                // Our own injected copy comes back unchanged; only adopt a NEW one.
                if supabase.auth.currentSession?.refreshToken == refresh { return }
                Task { try? await supabase.auth.setSession(accessToken: access, refreshToken: refresh) }
            case "signedOut":
                // Only follow it if the app's own session is gone too (a real
                // sign-out), not a transient clear during a page refresh.
                Task {
                    if (try? await supabase.auth.session) == nil {
                        await app.handleWebSignOut()
                    }
                }
            default:
                break
            }
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else { return .allow }
            let scheme = url.scheme?.lowercased() ?? ""

            if ["tel", "mailto", "sms", "maps"].contains(scheme) {
                await UIApplication.shared.open(url)
                return .cancel
            }
            guard scheme == "http" || scheme == "https" else { return .allow }

            // Other websites (company site, bug report form, file links) open in Safari.
            if navigationAction.targetFrame?.isMainFrame != false, url.host?.lowercased() != portalHost {
                await UIApplication.shared.open(url)
                return .cancel
            }

            // auth-guard.js sends signed-out visitors to the login page. Inside
            // the app that means the hand-off didn't take: retry once with fresh
            // tokens, then give up and sign out.
            let last = url.deletingPathExtension().lastPathComponent.lowercased()
            if last == "login" {
                loginBounceCount += 1
                if loginBounceCount <= 1, let target = targetURL {
                    _ = try? await supabase.auth.refreshSession()
                    load(target)
                } else {
                    onLoadingChange(false)
                    onError("Your session expired. Please sign in again.")
                }
                return .cancel
            }
            return .allow
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            // Files the web view can't display (spreadsheets, Word docs, zips)
            // go to Safari, which can download them.
            if !navigationResponse.canShowMIMEType, let url = navigationResponse.response.url {
                await UIApplication.shared.open(url)
                return .cancel
            }
            return .allow
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loginBounceCount = 0
            onLoadingChange(false)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handleLoadError(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            handleLoadError(error)
        }

        private func handleLoadError(_ error: Error) {
            onLoadingChange(false)
            let nsError = error as NSError
            // Cancelled loads (we cancelled to open Safari, or a quick re-navigation) aren't errors.
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return } // frame load interrupted
            if AppConfig.portalBaseURL.host?.contains("YOUR-PORTAL") == true {
                onError("The portal's web address hasn't been set yet (AppConfig.portalBaseURL).")
            } else {
                onError(error.localizedDescription)
            }
        }

        // MARK: WKUIDelegate

        /// target="_blank" links: open portal pages in place, everything else in Safari.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                if url.host?.lowercased() == portalHost {
                    webView.load(URLRequest(url: url))
                } else {
                    UIApplication.shared.open(url)
                }
            }
            return nil
        }
    }
}

/// WKUserContentController keeps a strong reference to its message handlers;
/// this breaks the cycle so the web view and coordinator can be freed.
@MainActor
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
