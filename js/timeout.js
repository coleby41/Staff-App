/**
 * idle-timeout.js
 * ----------------
 * Signs the user out after 5 minutes of inactivity — UNLESS they ticked
 * "Remember this device" on the login page (localStorage "rememberDevice"
 * = "1", set by js/login.js). A remembered device stays signed in until
 * they sign out themselves.
 *
 * Inactivity is measured from a "last activity" timestamp in localStorage
 * (shared by every open tab), not from a timer that started when the page
 * loaded. Phones pause timers while the app is in the background and fire
 * them all at once when it comes back, which used to sign people out the
 * moment they reopened the app; now it only signs out if they really were
 * away longer than the limit.
 */

(function () {
  "use strict";

  // ---------- CONFIG ----------
  const CONFIG = {
    idleTimeoutMs: 5 * 60 * 1000,   // sign out after 5 minutes idle
    warningBeforeMs: 30 * 1000,     // show a warning 30 seconds before
    loginPage: "/index.html",
  };
  const REMEMBER_KEY = "rememberDevice";
  const LAST_ACTIVITY_KEY = "lastActivityAt";
  // -----------------------------

  function isRemembered() {
    try { return localStorage.getItem(REMEMBER_KEY) === "1"; } catch (e) { return false; }
  }

  // A remembered device never times out.
  if (isRemembered()) return;

  let idleTimer = null;
  let warningTimer = null;
  let warningEl = null;
  let signingOut = false;

  function now() { return Date.now(); }

  function readLastActivity() {
    try {
      const v = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) { return 0; }
  }

  function writeLastActivity(t) {
    try { localStorage.setItem(LAST_ACTIVITY_KEY, String(t)); } catch (e) { /* private mode */ }
  }

  async function goToLogin() {
    if (signingOut || isRemembered()) return;
    signingOut = true;
    if (typeof window.signOutUser === "function") {
      await window.signOutUser();
    } else {
      localStorage.removeItem("staffProfile");
      window.location.href = CONFIG.loginPage + "?reason=idle";
    }
  }

  function showWarning() {
    if (warningEl) return;
    warningEl = document.createElement("div");
    warningEl.textContent = "You will be logged out soon due to inactivity.";
    warningEl.style.cssText =
      "position:fixed;bottom:20px;right:20px;z-index:9999;background:#333;color:#fff;" +
      "padding:12px 18px;border-radius:6px;font-family:sans-serif;font-size:14px;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.3);";
    document.body.appendChild(warningEl);
  }

  function clearWarning() {
    if (warningEl) { warningEl.remove(); warningEl = null; }
  }

  // Schedule the warning + sign-out from the shared last-activity time, so
  // activity in another tab keeps this one alive too.
  function schedule() {
    clearTimeout(idleTimer);
    clearTimeout(warningTimer);
    const remaining = CONFIG.idleTimeoutMs - (now() - (readLastActivity() || now()));
    if (remaining <= 0) { goToLogin(); return; }
    if (remaining > CONFIG.warningBeforeMs) {
      warningTimer = setTimeout(showWarning, remaining - CONFIG.warningBeforeMs);
    } else {
      showWarning();
    }
    idleTimer = setTimeout(check, remaining);
  }

  // Timer fired (possibly late, after the phone woke the app): only sign out
  // if the user has truly been idle that long.
  function check() {
    if (isRemembered()) { clearWarning(); return; }
    const idleFor = now() - (readLastActivity() || now());
    if (idleFor >= CONFIG.idleTimeoutMs) goToLogin();
    else { clearWarning(); schedule(); }
  }

  let lastWrite = 0;
  function onActivity() {
    const t = now();
    clearWarning();
    // Throttle the localStorage write (mousemove fires constantly).
    if (t - lastWrite > 5000) { lastWrite = t; writeLastActivity(t); schedule(); }
  }

  ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"].forEach((event) => {
    document.addEventListener(event, onActivity, { passive: true });
  });

  // Coming back to the tab/app: decide from the real idle time.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  window.addEventListener("pageshow", check);

  // Another tab was active: re-plan from its timestamp.
  window.addEventListener("storage", (e) => {
    if (e.key === LAST_ACTIVITY_KEY) { clearWarning(); schedule(); }
    if (e.key === REMEMBER_KEY && isRemembered()) { clearTimeout(idleTimer); clearTimeout(warningTimer); clearWarning(); }
  });

  // Page load: if the last activity is older than the limit (app reopened
  // after a long time), sign out now; otherwise this load counts as activity.
  const last = readLastActivity();
  if (last && now() - last >= CONFIG.idleTimeoutMs) {
    goToLogin();
  } else {
    writeLastActivity(now());
    lastWrite = now();
    schedule();
  }
})();
