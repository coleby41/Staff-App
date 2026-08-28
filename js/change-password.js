/* ===========================
   CHANGE PASSWORD (Supabase) — shared across every page with the
   notification center's bell dropdown. Opened via the "Change Password"
   action added there (see notifications.js for the sibling dropdown
   logic this loads alongside, and styles.css's
   .notification-change-password-* rules for the button itself).

   Requires the person's CURRENT password before accepting a new one.
   Supabase's client-side auth.updateUser({ password }) trusts whatever
   session is already active and does not itself check a "current
   password" — so this re-verifies it explicitly first, the exact same
   way sign-in already works (get_login_email RPC resolves the synthetic
   auth email for this username, then a real signInWithPassword call
   checks it), before ever calling updateUser. A wrong current password
   fails at that re-auth step and never touches the account.
=========================== */

function getChangePasswordProfile() {
    if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
    try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); }
    catch { return null; }
}

function setChangePasswordMessage(text, type) {
    const el = document.getElementById("changePasswordMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `auth-message ${type || ""}`.trim();
}

function setChangePasswordSubmitState(disabled, label) {
    const btn = document.getElementById("submitChangePasswordBtn");
    if (!btn) return;
    btn.disabled = disabled;
    if (label) btn.textContent = label;
}

function resetChangePasswordForm() {
    document.getElementById("changePasswordForm")?.reset();
    setChangePasswordMessage("", "");
    setChangePasswordSubmitState(false, "Update Password");
}

function openChangePasswordModal() {
    resetChangePasswordForm();
    document.getElementById("changePasswordModalOverlay")?.classList.remove("hidden");
    document.body.classList.add("popup-active");
    // Close the notification dropdown itself so it doesn't sit open behind the modal.
    document.getElementById("notificationDropdown")?.classList.remove("active");
    document.getElementById("changePasswordCurrentInput")?.focus();
}

function closeChangePasswordModal() {
    document.getElementById("changePasswordModalOverlay")?.classList.add("hidden");
    document.body.classList.remove("popup-active");
    resetChangePasswordForm();
}

async function handleChangePasswordSubmit(event) {
    event.preventDefault();

    const currentPassword = document.getElementById("changePasswordCurrentInput")?.value || "";
    const newPassword = document.getElementById("changePasswordNewInput")?.value || "";
    const confirmPassword = document.getElementById("changePasswordConfirmInput")?.value || "";

    if (!currentPassword) {
        setChangePasswordMessage("Enter your current password.", "error");
        return;
    }
    if (newPassword.length < 8) {
        setChangePasswordMessage("New password must be at least 8 characters.", "error");
        return;
    }
    if (newPassword !== confirmPassword) {
        setChangePasswordMessage("New passwords do not match.", "error");
        return;
    }
    if (newPassword === currentPassword) {
        setChangePasswordMessage("New password must be different from your current password.", "error");
        return;
    }
    if (!window.supabaseClient) {
        setChangePasswordMessage("Unable to reach the server. Try again.", "error");
        return;
    }

    const profile = getChangePasswordProfile();
    const username = profile?.username;
    if (!username) {
        setChangePasswordMessage("Your session isn't fully loaded yet. Try again in a moment.", "error");
        return;
    }

    setChangePasswordSubmitState(true, "Checking current password...");
    setChangePasswordMessage("Checking current password...", "");

    // Re-verify the current password the same way sign-in does, rather than
    // trusting whatever's typed — resolve this username's synthetic auth
    // email, then a real signInWithPassword check against it.
    const { data: authEmail, error: lookupError } = await window.supabaseClient.rpc(
        "get_login_email",
        { p_username: username }
    );

    if (lookupError || !authEmail) {
        setChangePasswordMessage("Unable to verify your account. Try again.", "error");
        setChangePasswordSubmitState(false, "Update Password");
        return;
    }

    const { error: reauthError } = await window.supabaseClient.auth.signInWithPassword({
        email: authEmail,
        password: currentPassword,
    });

    if (reauthError) {
        setChangePasswordMessage("Current password is incorrect.", "error");
        setChangePasswordSubmitState(false, "Update Password");
        return;
    }

    setChangePasswordMessage("Saving your new password...", "");
    setChangePasswordSubmitState(true, "Saving...");

    const { error: updateError } = await window.supabaseClient.auth.updateUser({ password: newPassword });

    if (updateError) {
        setChangePasswordMessage(updateError.message || "Unable to update your password. Try again.", "error");
        setChangePasswordSubmitState(false, "Update Password");
        return;
    }

    setChangePasswordMessage("Password updated.", "success");
    setChangePasswordSubmitState(true, "Updated");

    setTimeout(closeChangePasswordModal, 1200);
}

function wireChangePassword() {
    document.getElementById("changePasswordBtn")?.addEventListener("click", function (event) {
        event.preventDefault();
        openChangePasswordModal();
    });
    document.getElementById("cancelChangePasswordBtn")?.addEventListener("click", closeChangePasswordModal);
    document.getElementById("closeChangePasswordBtn")?.addEventListener("click", closeChangePasswordModal);
    document.getElementById("changePasswordModalOverlay")?.addEventListener("click", function (event) {
        if (event.target === this) closeChangePasswordModal();
    });
    document.getElementById("changePasswordForm")?.addEventListener("submit", handleChangePasswordSubmit);
    document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        const overlay = document.getElementById("changePasswordModalOverlay");
        if (overlay && !overlay.classList.contains("hidden")) closeChangePasswordModal();
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireChangePassword);
} else {
    wireChangePassword();
}
