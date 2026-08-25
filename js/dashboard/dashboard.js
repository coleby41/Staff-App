/* ============================================================================
   dashboard-shared.js
   Shared helpers for the new dashboard cards (Tasks, Quick Links, Weather,
   Company Updates, Project Snapshot, Calendar, Important Contacts).

   This is a NEW, standalone file — nothing in supabase-auth.js, auth-guard.js,
   script.js, or timeout.js is modified. Every card script below loads this
   file first and reads from the `window.DashboardShared` namespace it
   creates, so there's a single place that knows how to:
     - wait for the logged-in profile to be available (profile hydration is
       async on page reload — see memory notes on this exact gotcha)
     - open/close popups using the portal's existing .popup-overlay/.popup
       classes
     - escape user text before injecting into innerHTML
     - check role membership for gated actions (Company Updates)
     - format dates the way the dashboard screenshot does (Due today / Due
       tomorrow / Overdue)

   Include this ONE script tag before any *-card.js file:
     <script src="dashboard-shared.js"></script>
============================================================================ */

(function () {
  "use strict";

  const READ_PROFILE_TIMEOUT_MS = 5000;
  const READ_PROFILE_POLL_MS = 200;

  /**
   * Resolves with the current staff profile ({ id, full_name, username, ... })
   * once it's available on window.currentSupabaseProfile or
   * localStorage.staffProfile. Mirrors the polling approach already used
   * elsewhere in the portal, because on a hard page reload
   * window.currentSupabaseProfile isn't set synchronously.
   */
  function getStaffProfile() {
    return new Promise((resolve) => {
      const start = Date.now();

      function tryRead() {
        if (window.currentSupabaseProfile) {
          resolve(window.currentSupabaseProfile);
          return;
        }

        try {
          const stored = localStorage.getItem("staffProfile");
          if (stored) {
            resolve(JSON.parse(stored));
            return;
          }
        } catch (err) {
          console.warn("DashboardShared: could not parse staffProfile", err);
        }

        if (Date.now() - start >= READ_PROFILE_TIMEOUT_MS) {
          resolve(null);
          return;
        }

        setTimeout(tryRead, READ_PROFILE_POLL_MS);
      }

      tryRead();
    });
  }

  function getUserId(profile) {
    return profile ? profile.id || profile.uid || null : null;
  }

  /**
   * Role check reusing the same window.isSupabaseUserInGroup helper the
   * dashboard header already relies on for showing/hiding the IT Tools nav.
   * Falls back to false if that helper isn't present for some reason.
   */
  function userHasAnyRole(profile, roles) {
    if (!profile || !window.isSupabaseUserInGroup) return false;
    return roles.some((role) => window.isSupabaseUserInGroup(profile, role));
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  /* ---------------------------------------------------------------------
     Generic popup helpers — reuse .popup-overlay / .popup from styles.css.
     Each card builds its own inner markup and calls
     DashboardShared.openPopup(overlayEl) / closePopup(overlayEl).
  --------------------------------------------------------------------- */

  function openPopup(overlayEl) {
    if (!overlayEl) return;
    overlayEl.classList.remove("hidden");
    document.body.classList.add("popup-active");
  }

  function closePopup(overlayEl) {
    if (!overlayEl) return;
    overlayEl.classList.add("hidden");
    document.body.classList.remove("popup-active");
  }

  /**
   * Builds a .popup-overlay/.popup pair from an HTML string for the popup's
   * inner content, appends it to <body>, and wires Escape / backdrop-click
   * to close. Returns the overlay element.
   */
  function buildPopup(id, innerHtml, options) {
    options = options || {};
    let overlay = document.getElementById(id);
    if (overlay) overlay.remove();

    overlay = document.createElement("div");
    overlay.id = id;
    overlay.className = "popup-overlay hidden";

    const popup = document.createElement("div");
    popup.className = "popup" + (options.extraClass ? " " + options.extraClass : "");
    popup.innerHTML = innerHtml;

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closePopup(overlay);
    });

    document.addEventListener("keydown", function escHandler(e) {
      if (e.key === "Escape" && !overlay.classList.contains("hidden")) {
        closePopup(overlay);
      }
    });

    return overlay;
  }

  /* ---------------------------------------------------------------------
     Inline form-message helper (reuses .auth-message / .auth-message.error
     / .auth-message.success already defined in styles.css).
  --------------------------------------------------------------------- */

  function setFormMessage(el, text, type) {
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("success", "error");
    if (type) el.classList.add(type);
  }

  /* ---------------------------------------------------------------------
     Date formatting matching the dashboard screenshot's task chips.
  --------------------------------------------------------------------- */

  function formatDueLabel(dueDateStr) {
    if (!dueDateStr) return { text: "No due date", cls: "" };

    const due = new Date(dueDateStr + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const diffDays = Math.round((due - today) / 86400000);

    if (diffDays < 0) return { text: "Overdue", cls: "due-overdue" };
    if (diffDays === 0) return { text: "Due today", cls: "due-today" };
    if (diffDays === 1) return { text: "Due tomorrow", cls: "due-tomorrow" };
    return {
      text: due.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      cls: "due-upcoming",
    };
  }

  function formatEventTime(startIso, endIso) {
    const start = new Date(startIso);
    const opts = { hour: "numeric", minute: "2-digit" };
    let text = start.toLocaleTimeString("en-US", opts);
    if (endIso) {
      text += " – " + new Date(endIso).toLocaleTimeString("en-US", opts);
    }
    return text;
  }

  /* ---------------------------------------------------------------------
     Small wrapper so every card gets the same console-error pattern
     instead of copy/pasting try/catch everywhere.
  --------------------------------------------------------------------- */

  async function safeQuery(label, queryPromise) {
    if (!window.supabaseClient) {
      console.error(`DashboardShared: supabaseClient not ready (${label})`);
      return { data: null, error: new Error("Supabase client not ready") };
    }
    const { data, error } = await queryPromise;
    if (error) {
      console.error(`DashboardShared: ${label} failed`, error);
    }
    return { data, error };
  }

  window.DashboardShared = {
    getStaffProfile,
    getUserId,
    userHasAnyRole,
    escapeHtml,
    openPopup,
    closePopup,
    buildPopup,
    setFormMessage,
    formatDueLabel,
    formatEventTime,
    safeQuery,
  };
})();