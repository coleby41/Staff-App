import SwiftUI

/// The blue rounded "LG" style mark from the portal header.
struct BrandMark: View {
    var size: CGFloat = 44
    var text: String = "LG"

    var body: some View {
        Text(text)
            .font(.system(size: size * 0.36, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(
                LinearGradient(colors: [Theme.accent, Theme.accentStrong], startPoint: .topLeading, endPoint: .bottomTrailing)
            )
            .clipShape(RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
    }
}

/// Label above an input, in a white rounded field.
struct LabeledField<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold))
            content
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(Theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border))
        }
    }
}

/// Small colored capsule (status chips, due-date pills).
struct Pill: View {
    let text: String
    var foreground: Color = Theme.accent
    var background: Color = Theme.accentSoft

    var body: some View {
        Text(text)
            .font(.caption.weight(.bold))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .foregroundStyle(foreground)
            .background(background)
            .clipShape(Capsule())
    }
}

struct StatusPill: View {
    let statusKey: String
    var body: some View {
        let colors: (Color, Color) = {
            switch statusKey {
            case "active": return (Theme.success, Color(hex: 0xE6F4EC))
            case "onboarding": return (Theme.accent, Theme.accentSoft)
            case "completed": return (Color(hex: 0x6B4FB0), Color(hex: 0xEFE9FB))
            default: return (Theme.textSoft, Color(hex: 0xEEF0F3))
            }
        }()
        Pill(text: ProjectStatus.label(for: statusKey), foreground: colors.0, background: colors.1)
    }
}

/// Section heading used inside scroll views.
struct SectionHeader: View {
    let title: String
    var trailing: AnyView? = nil
    var body: some View {
        HStack {
            Text(title).font(.headline)
            Spacer()
            trailing
        }
    }
}

// MARK: - Dates (matching the web's formatting)

enum DateText {
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// "2026-10-09" (or a full timestamp) -> local Date at midnight.
    static func day(_ string: String?) -> Date? {
        guard let string, string.count >= 10 else { return nil }
        return isoDay.date(from: String(string.prefix(10)))
    }

    /// Today in the office's time zone as yyyy-MM-dd (the web's todayDateParts()).
    static func officeToday() -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = AppConfig.officeTimeZone
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }

    static func isoString(from date: Date) -> String { isoDay.string(from: date) }

    enum DueTier { case overdue, today, tomorrow, upcoming, none }

    /// DashboardShared.formatDueLabel(): Overdue / Due today / Due tomorrow / "Oct 9".
    static func due(_ string: String?) -> (text: String, tier: DueTier) {
        guard let due = day(string) else { return ("No due date", .none) }
        let today = Calendar.current.startOfDay(for: Date())
        let diff = Calendar.current.dateComponents([.day], from: today, to: due).day ?? 0
        if diff < 0 { return ("Overdue", .overdue) }
        if diff == 0 { return ("Due today", .today) }
        if diff == 1 { return ("Due tomorrow", .tomorrow) }
        return (due.formatted(.dateTime.month(.abbreviated).day()), .upcoming)
    }

    /// Timestamps from Postgres (timestamptz).
    static func timestamp(_ string: String?) -> Date? {
        guard let string else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: string) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let d = plain.date(from: string) { return d }
        return day(string)
    }

    /// notification-center.js ncFormatDate(): Just now / 5m ago / 3h ago / Oct 9, 2026.
    static func relative(_ string: String?) -> String {
        guard let date = timestamp(string) else { return "" }
        let minutes = Int(Date().timeIntervalSince(date) / 60)
        if minutes < 1 { return "Just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        if minutes < 60 * 24 { return "\(Int((Double(minutes) / 60).rounded()))h ago" }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }
}

extension DateText.DueTier {
    var colors: (Color, Color) {
        switch self {
        case .overdue: return (Theme.danger, Theme.dangerSoft)
        case .today: return (Theme.warning, Theme.warningSoft)
        case .tomorrow: return (Theme.accent, Theme.accentSoft)
        case .upcoming, .none: return (Theme.textSoft, .clear)
        }
    }
}

/// "$1.2M" / "$350K" / "$900" like the web's formatProjectValue().
func compactCurrency(_ value: Double) -> String {
    switch value {
    case 1_000_000...: return "$" + String(format: "%.1fM", value / 1_000_000).replacingOccurrences(of: ".0M", with: "M")
    case 1_000...: return "$" + String(format: "%.0fK", value / 1_000)
    default: return value.formatted(.currency(code: "USD").precision(.fractionLength(0)))
    }
}

/// Simple full-screen error / empty message with a retry.
struct LoadErrorView: View {
    let message: String
    let retry: () async -> Void
    var body: some View {
        ContentUnavailableView {
            Label("Couldn't load", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try Again") { Task { await retry() } }
                .buttonStyle(.borderedProminent)
        }
    }
}
