/**
 * idle-timeout.js
 * ----------------
 * Automatically redirects the user to the login page after inactivity.
 */

(function () {
  "use strict";

  // ---------- CONFIG ----------
  const CONFIG = {
    // Time before logout (2 minutes)
    idleTimeoutMs: 2 * 60 * 1000,

    // Login page location
    loginPage: "index.html",

    // Warning before logout
    warningBeforeMs: 30 * 1000,

    // Optional Supabase logout
supabaseClient: window.supabaseClient || window.SUPABASE_CONFIG || null,

    // Message added to login URL
    reasonParam: "reason=idle",
  };
  // -----------------------------

  let idleTimer = null;
  let warningTimer = null;
  let warningEl = null;


  async function goToLogin() {
  console.log("Redirecting to login due to inactivity...");

  if (typeof window.signOutUser === "function") {
    await window.signOutUser();
  } else {
    // fallback if supabase-auth.js wasn't loaded for some reason
    localStorage.removeItem("staffProfile");
    window.location.href = CONFIG.loginPage + "?reason=idle";
  }
}


  function showWarning() {
    console.log("Showing timeout warning");

    if (warningEl) return;

    warningEl = document.createElement("div");

    warningEl.textContent =
      "You will be logged out soon due to inactivity.";

    warningEl.style.cssText =
      "position:fixed;" +
      "bottom:20px;" +
      "right:20px;" +
      "z-index:9999;" +
      "background:#333;" +
      "color:#fff;" +
      "padding:12px 18px;" +
      "border-radius:6px;" +
      "font-family:sans-serif;" +
      "font-size:14px;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.3);";

    document.body.appendChild(warningEl);
  }


  function clearWarning() {
    if (warningEl) {
      warningEl.remove();
      warningEl = null;
    }
  }


  function resetIdleTimer() {

    clearWarning();

    clearTimeout(idleTimer);
    clearTimeout(warningTimer);


    if (
      CONFIG.warningBeforeMs > 0 &&
      CONFIG.warningBeforeMs < CONFIG.idleTimeoutMs
    ) {
      warningTimer = setTimeout(
        showWarning,
        CONFIG.idleTimeoutMs - CONFIG.warningBeforeMs
      );
    }


    idleTimer = setTimeout(() => {
      console.log("Idle timeout reached!");
      goToLogin();
    }, CONFIG.idleTimeoutMs);
  }


  const activityEvents = [
    "mousemove",
    "mousedown",
    "keydown",
    "scroll",
    "touchstart",
    "click",
  ];


  activityEvents.forEach((event) => {
    document.addEventListener(event, resetIdleTimer, {
      passive: true,
    });
  });


  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      resetIdleTimer();
    }
  });


  // Start timer

  resetIdleTimer();

})();