import Foundation
import Supabase

/// One shared client for the whole app. The session is kept in the iOS
/// Keychain by supabase-swift, so people stay signed in between launches.
let supabase = SupabaseClient(
    supabaseURL: AppConfig.supabaseURL,
    supabaseKey: AppConfig.supabaseKey
)

/// Friendly error text for alerts. Database/RLS errors come back with a
/// message; anything else gets a generic line.
func friendlyMessage(for error: Error, fallback: String = "Something went wrong. Please try again.") -> String {
    if error is URLError || (error as NSError).domain == NSURLErrorDomain {
        return "Can't reach the server. Check your connection and try again."
    }
    // PostgrestError, StorageError and AuthError all conform to SupabaseError.
    if let supabaseError = error as? any SupabaseError {
        if supabaseError.underlyingError is URLError {
            return "Can't reach the server. Check your connection and try again."
        }
        return supabaseError.message
    }
    return fallback
}

/// Storage paths in the portal replace anything unusual in a file name with "_".
/// (project-fields.js uploadFile(): /[^a-zA-Z0-9_.-]/g -> "_")
func safeStorageName(_ name: String) -> String {
    String(name.unicodeScalars.map { scalar -> Character in
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")
        return allowed.contains(scalar) ? Character(scalar) : "_"
    })
}

/// Milliseconds since 1970, like JavaScript's Date.now(), used in storage paths.
func jsNowMillis() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded())
}
