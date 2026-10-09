import Foundation

/// Everything environment-specific lives here.
enum AppConfig {
    /// Same project + publishable key the web portal uses (js/supabase-config.js).
    /// The publishable key is meant to be public; every request is still
    /// protected by Row Level Security on the server.
    static let supabaseURL = URL(string: "https://ostaqjuawieqpwuhrvsm.supabase.co")!
    static let supabaseKey = "sb_publishable_W1J14WASXA9shdqziBFjJg_qTtohpU9"

    /// The project ref is the subdomain above. supabase-js stores its session in
    /// localStorage under "sb-<ref>-auth-token"; the in-app web view writes the
    /// app's session there so portal pages open already signed in.
    static let supabaseProjectRef = "ostaqjuawieqpwuhrvsm"

    /// TODO: paste the live portal's address here (the vercel.app URL, no trailing slash).
    /// Used for every page that isn't native yet (they open inside the app).
    static let portalBaseURL = URL(string: "https://YOUR-PORTAL.vercel.app")!

    /// The office's time zone, used for "today" on reports (matches the web).
    static let officeTimeZone = TimeZone(identifier: "America/New_York")!

    static let companySiteURL = URL(string: "https://www.theleewardgroup.us/")!

    /// Builds a full portal URL from a path like "/pages/vendors.html".
    static func portalURL(_ path: String) -> URL {
        if let absolute = URL(string: path), absolute.scheme != nil { return absolute }
        let cleaned = path.hasPrefix("/") ? path : "/" + path
        return URL(string: portalBaseURL.absoluteString + cleaned) ?? portalBaseURL
    }
}
