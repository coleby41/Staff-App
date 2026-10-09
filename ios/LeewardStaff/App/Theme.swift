import SwiftUI

/// The portal's colors (css/styles.css :root), so the app matches the website.
enum Theme {
    static let accent = Color(hex: 0x085C98)
    static let accentStrong = Color(hex: 0x053F67)
    static let accentSoft = Color(hex: 0xE7EEF3)
    static let background = Color(hex: 0xF2F4F7)
    static let surface = Color.white
    static let border = Color(hex: 0xDCE2E8)
    static let text = Color(hex: 0x14263A)
    static let textSoft = Color(hex: 0x5F6E7D)
    static let danger = Color(hex: 0xB24B4B)
    static let dangerSoft = Color(hex: 0xFDECEB)
    static let warning = Color(hex: 0xA5661E)
    static let warningSoft = Color(hex: 0xFFF3E5)
    static let success = Color(hex: 0x2E7D4F)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// White rounded card used throughout (the web's `.card`).
struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Theme.border, lineWidth: 1)
            )
    }
}

extension View {
    func card() -> some View { modifier(CardStyle()) }
}
