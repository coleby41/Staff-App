# Leeward Staff — iOS app

A native SwiftUI app for the staff portal. It signs in with the same accounts, reads and writes the same Supabase tables, and follows the same permissions as the website, so nothing on the server changes.

## What's native vs. what opens from the portal

| Native (SwiftUI) | Opens the portal page inside the app |
|---|---|
| Sign in, first-login password reset, Change Password | Time Sheet / Staff Finance |
| **Home**: My Tasks (check off, quick add), Project Snapshot, notifications bell | Vendor Information, Account Activity |
| **Tasks**: My Tasks (Open / All, add, reopen) + project to-dos assigned to you | Payroll Tools, Manage Employees |
| **Projects**: list (search, status tabs), project overview, **Files** (browse, open, upload photos/files), **Contacts** (tap to call / email) | Excel Workbook Templates, Form Templates |
| **Report**: Incident Report (camera, photos, PDFs) | IT Tools (Create Account, Staff Users, Workgroups) |
| **More**: menu, Change Password, Sign out | A project's To-Do, Form Logs, full Overview |

Pages that open from the portal sign in automatically (the app passes its session to the page) and hide the website's own header and tab bar. The project **Timeline** stays desktop-only, same as on the phone website.

On iOS 26 the tab bar automatically uses Apple's floating Liquid Glass style. On iOS 17–18 it's the standard tab bar.

## First-time setup (on your Mac)

1. **Install Xcode** from the Mac App Store (Xcode 16 or newer; Xcode 26 for the Liquid Glass tab bar).
2. **Set the portal address.** Open `LeewardStaff/App/Config.swift` and replace `https://YOUR-PORTAL.vercel.app` with the live portal's address (no trailing slash). Without it, everything native still works, but pages that open from the portal show "address hasn't been set".
3. **Open the project.** Double-click `LeewardStaff.xcodeproj`. Xcode downloads the Supabase package automatically the first time (watch the progress in the top bar).
4. **Signing.** Click the blue **LeewardStaff** project at the top of the file list → **Signing & Capabilities** → **Team**: pick your Apple ID (Xcode → Settings → Accounts to add it). If Xcode says the bundle identifier is taken, change `com.leewardgroup.staff` to something unique.
5. **Run.** Pick an iPhone simulator (or your plugged-in iPhone) in the top bar and press **⌘R**.

If the build fails, copy the first red error from Xcode's Issue navigator (⌘5) and send it over. This project was written without access to a Mac, so a few small compile fixes on the first build are likely.

## Putting it on phones

- **Your own phone:** plug it in, select it as the run destination, press ⌘R. (Free Apple IDs can do this; the app expires after 7 days.)
- **The team:** join the Apple Developer Program, then Product → Archive → Distribute → **TestFlight**. Staff install the TestFlight app and get updates automatically. Public App Store release isn't needed for an internal tool.

## How it's organized

```
LeewardStaff/
  App/          LeewardStaffApp (entry, tab bar), Config (URLs/keys), Theme (portal colors)
  Services/     SupabaseService (client), AppState (sign-in + permissions), PortalAPI (every query)
  Models/       Table models; FileCategories (project folder list, copied from project-fields.js)
  Views/        Login, Home, Tasks, Projects, Report, More, Web (in-app portal pages), Shared
```

The project uses a synchronized folder: any `.swift` file added under `LeewardStaff/` is picked up by Xcode automatically.

## Keeping it in sync with the website

- **Queries** live in `Services/PortalAPI.swift`, each noting which web file it mirrors. If a table or column changes on the web, update it there.
- **Project folders** are copied from `js/project-fields.js` (`PROJECT_FILE_CATEGORIES`) into `Models/FileCategories.swift`.
- **Permissions** use the same keys as `js/nav-access.js` / `js/permissions.js`, including Super Admin and Manager rules, and fail open the same way.
- **Incident reports** follow `js/incident-report.js` exactly: same validation, storage paths, attachment metadata, and approver notification.
