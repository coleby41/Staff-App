/* ============================================================================
   calendar-card.js — "Calendar" dashboard card
   Requires this markup in dashboard.html:

     <div class="card">
       <div class="card-header">
         <h2 class="card-title">🗓️ Calendar</h2>
         <a href="#" id="linkCalendarLink" class="chip">Link Calendar</a>
         <a href="#" id="manageCalendarLink" class="chip" style="display:none;">Manage Calendar</a>
       </div>
       <div id="calendarEventsList" class="info-list"></div>
     </div>

   ⚠️ CONFIG REQUIRED: set EDGE_FUNCTIONS_BASE_URL below to your Supabase
   project's Edge Functions base URL, e.g.
   "https://abcxyzproject.functions.supabase.co". See
   /supabase/functions/README.md for how to deploy the 5 functions this
   card talks to (calendar-oauth-start, calendar-oauth-callback,
   calendar-caldav-connect, calendar-events-sync, calendar-disconnect).

   Tables read: public.calendar_connections_status (safe view — no tokens),
   public.calendar_providers, public.calendar_events_cache.
============================================================================ */

(function () {
  "use strict";

  const DS = window.DashboardShared;
  const MAX_EVENTS = 4;

  const EDGE_FUNCTIONS_BASE_URL = "https://ostaqjuawieqpwuhrvsm.supabase.co/functions/v1";

  let currentProfile = null;
  // The user's calendar connection row (status/provider/email), refreshed
  // every time refreshCalendarCard() runs. Used by the Manage Calendar popup
  // so it doesn't need its own separate fetch just to know what's connected.
  let currentConnection = null;

  document.addEventListener("DOMContentLoaded", async () => {
    const listEl = document.getElementById("calendarEventsList");
    const linkEl = document.getElementById("linkCalendarLink");
    const manageEl = document.getElementById("manageCalendarLink");
    if (!listEl) return;

    currentProfile = await DS.getStaffProfile();
    if (!currentProfile) {
      listEl.innerHTML = `<p class="card-subtitle">Sign in to see your calendar.</p>`;
      if (linkEl) linkEl.style.display = "none";
      if (manageEl) manageEl.style.display = "none";
      return;
    }

    handlePostRedirectStatus();
    await refreshCalendarCard();

    if (linkEl) {
      linkEl.addEventListener("click", (e) => {
        e.preventDefault();
        openLinkCalendarModal();
      });
    }

    if (manageEl) {
      manageEl.addEventListener("click", (e) => {
        e.preventDefault();
        openManageCalendarModal();
      });
    }
  });

  function handlePostRedirectStatus() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("calendar_connected")) return;

    const success = params.get("calendar_connected") === "1";
    const message = success ? "Calendar connected." : `Couldn't connect calendar (${params.get("calendar_detail") || "unknown error"}).`;
    // Simple non-blocking notice; reuses the workbook page-message style.
    const banner = document.createElement("div");
    banner.className = `workbook-page-message ${success ? "success" : "error"}`;
    banner.textContent = message;
    document.querySelector(".main-content")?.prepend(banner);
    setTimeout(() => banner.remove(), 6000);

    params.delete("calendar_connected");
    params.delete("calendar_detail");
    const newUrl = window.location.pathname + (params.toString() ? `?${params}` : "");
    window.history.replaceState({}, "", newUrl);
  }

  async function refreshCalendarCard() {
    const listEl = document.getElementById("calendarEventsList");
    const linkEl = document.getElementById("linkCalendarLink");
    const manageEl = document.getElementById("manageCalendarLink");
    const userId = DS.getUserId(currentProfile);

    // Deliberately not filtering by status here (unlike before) — an "error"
    // connection still needs to show up so Manage Calendar can surface it
    // and offer Reconnect/Disconnect instead of silently looking unlinked.
    const { data: connections } = await DS.safeQuery(
      "load calendar_connections_status",
      window.supabaseClient
        .from("calendar_connections_status")
        .select("*")
        .eq("user_id", userId)
    );

    currentConnection = (connections && connections[0]) || null;
    const hasConnection = !!currentConnection;
    const isActive = hasConnection && currentConnection.status === "connected";

    if (linkEl) linkEl.style.display = hasConnection ? "none" : "inline-flex";
    if (manageEl) manageEl.style.display = hasConnection ? "inline-flex" : "none";

    if (!hasConnection) {
      listEl.innerHTML = `<p class="card-subtitle">No calendar linked yet. Use "Link Calendar" above to connect one.</p>`;
      return;
    }

    if (!isActive) {
      listEl.innerHTML = `<p class="card-subtitle">Your calendar connection needs attention. Open "Manage Calendar" above to reconnect.</p>`;
      return;
    }

    const { data: events, error } = await DS.safeQuery(
      "load calendar_events_cache",
      window.supabaseClient
        .from("calendar_events_cache")
        .select("id, title, start_time, end_time, location")
        .eq("user_id", userId)
        .gte("start_time", new Date().toISOString())
        .order("start_time", { ascending: true })
        .limit(MAX_EVENTS)
    );

    if (error) {
      listEl.innerHTML = `<p class="card-subtitle">Couldn't load your events.</p>`;
      return;
    }

    if (!events || events.length === 0) {
      listEl.innerHTML = `<p class="card-subtitle">Nothing on your calendar in the next 30 days.</p>`;
      return;
    }

    listEl.innerHTML = events
      .map(
        (ev) => `
        <div class="info-item">
          <div>
            <h3>${DS.escapeHtml(ev.title)}</h3>
            <p>${DS.formatEventTime(ev.start_time, ev.end_time)}${ev.location ? " · " + DS.escapeHtml(ev.location) : ""}</p>
          </div>
        </div>
      `
      )
      .join("");
  }

  /* ------------------------------------------------------------------- */

  async function openLinkCalendarModal() {
    const { data: providers } = await DS.safeQuery(
      "load calendar_providers",
      window.supabaseClient
        .from("calendar_providers")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
    );

    const overlay = DS.buildPopup(
      "linkCalendarModal",
      `
      <h2>Link a calendar</h2>
      <p class="card-subtitle">Choose which calendar you'd like to connect.</p>
      <div id="providerList" class="equipment-list" style="margin:14px 0;"></div>
      <div id="caldavForm" style="display:none;">
        <div class="auth-divider"></div>
        <form id="caldavConnectForm" class="auth-form auth-form--compact">
          <h3>Connect Apple Calendar</h3>
          <p class="auth-inline-copy">
            Generate an app-specific password at
            <a class="auth-link" href="https://appleid.apple.com/account/manage" target="_blank" rel="noopener">appleid.apple.com</a>
            — Apple doesn't support one-click sign-in for calendar access.
          </p>
          <label class="auth-field">Apple ID email
            <input type="email" id="caldavUsername" required />
          </label>
          <label class="auth-field">App-specific password
            <input type="text" id="caldavPassword" required placeholder="xxxx-xxxx-xxxx-xxxx" />
          </label>
          <p id="caldavMessage" class="auth-message"></p>
          <div class="popup-buttons">
            <button type="button" class="auth-button auth-button--secondary" id="caldavCancelBtn">Back</button>
            <button type="submit" class="auth-button">Connect</button>
          </div>
        </form>
      </div>
      <div class="popup-buttons" id="linkCalendarCloseWrap">
        <button type="button" class="auth-button auth-button--secondary" id="closeLinkCalendarBtn">Close</button>
      </div>
      `
    );

    renderProviderList(overlay, providers || []);
    DS.openPopup(overlay);
    overlay.querySelector("#closeLinkCalendarBtn").addEventListener("click", () => DS.closePopup(overlay));
  }

  function renderProviderList(overlay, providers) {
    const listEl = overlay.querySelector("#providerList");
    listEl.innerHTML = providers
      .map(
        (p) => `
        <div class="equipment-item" style="cursor:pointer;" data-provider="${p.id}" data-auth-type="${p.auth_type}">
          <div>
            <h3>${DS.escapeHtml(p.label)}</h3>
            <p>${p.auth_type === "oauth2" ? "Sign in and grant read-only calendar access" : "Connect with an app-specific password"}</p>
          </div>
          <span class="chip">Connect</span>
        </div>
      `
      )
      .join("");

    listEl.querySelectorAll("[data-provider]").forEach((row) => {
      row.addEventListener("click", () => {
        const providerId = row.dataset.provider;
        const authType = row.dataset.authType;
        if (authType === "oauth2") {
          startOAuthFlow(providerId);
        } else {
          overlay.querySelector("#providerList").style.display = "none";
          overlay.querySelector("#linkCalendarCloseWrap").style.display = "none";
          overlay.querySelector("#caldavForm").style.display = "block";
          wireCaldavForm(overlay);
        }
      });
    });
  }

  function startOAuthFlow(providerId) {
    const userId = DS.getUserId(currentProfile);
    // This is a plain browser navigation (not a fetch), so we can't attach an
    // apikey header — Supabase's gateway also accepts it as a URL param, which
    // is required here or every request gets rejected with "No API key found
    // in request".
    const anonKey = window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.anonKey;
    const startUrl = `${EDGE_FUNCTIONS_BASE_URL}/calendar-oauth-start?provider=${encodeURIComponent(
      providerId
    )}&user_id=${encodeURIComponent(userId)}&apikey=${encodeURIComponent(anonKey || "")}`;
    window.location.href = startUrl;
  }

  function wireCaldavForm(overlay) {
    overlay.querySelector("#caldavCancelBtn").addEventListener("click", () => {
      overlay.querySelector("#caldavForm").style.display = "none";
      overlay.querySelector("#providerList").style.display = "flex";
      overlay.querySelector("#linkCalendarCloseWrap").style.display = "flex";
    });

    overlay.querySelector("#caldavConnectForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const messageEl = overlay.querySelector("#caldavMessage");
      const username = overlay.querySelector("#caldavUsername").value.trim();
      const password = overlay.querySelector("#caldavPassword").value.trim();

      if (!username || !password) {
        DS.setFormMessage(messageEl, "Both fields are required.", "error");
        return;
      }

      DS.setFormMessage(messageEl, "Connecting…", "");

      try {
        const anonKey = window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.anonKey;
        const res = await fetch(`${EDGE_FUNCTIONS_BASE_URL}/calendar-caldav-connect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: anonKey || "",
            Authorization: `Bearer ${anonKey || ""}`,
          },
          body: JSON.stringify({
            user_id: DS.getUserId(currentProfile),
            username,
            app_password: password,
          }),
        });
        const result = await res.json();

        if (!res.ok) {
          DS.setFormMessage(messageEl, result.error || "Couldn't connect.", "error");
          return;
        }

        DS.closePopup(overlay);
        refreshCalendarCard();
      } catch (err) {
        console.error("CalDAV connect failed", err);
        DS.setFormMessage(messageEl, "Couldn't reach the server. Try again.", "error");
      }
    });
  }

  /* ------------------------------------------------------------------- */
  /* Manage Calendar — status, manual sync, reconnect-on-error, disconnect */

  function statusPillClass(status) {
    if (status === "connected") return "connected";
    if (status === "error") return "error";
    return "disconnected";
  }

  function statusPillText(status) {
    if (status === "connected") return "Connected";
    if (status === "error") return "Needs attention";
    return status || "Unknown";
  }

  function openManageCalendarModal() {
    if (!currentConnection) return;

    const providerLabel = currentConnection.provider_label || currentConnection.provider_id;
    const accountEmail = currentConnection.external_account_email || "No account email on file";
    const isError = currentConnection.status === "error";

    const overlay = DS.buildPopup(
      "manageCalendarModal",
      `
      <h2>Manage Calendar</h2>
      <p class="card-subtitle">Connected via ${DS.escapeHtml(providerLabel)}</p>

      <div class="equipment-item" style="margin:14px 0;">
        <div>
          <h3>${DS.escapeHtml(accountEmail)}</h3>
          <p>${DS.escapeHtml(providerLabel)}</p>
        </div>
        <span class="status ${statusPillClass(currentConnection.status)}" id="manageCalendarStatus">${statusPillText(currentConnection.status)}</span>
      </div>

      <p class="auth-message" id="manageCalendarMessage"></p>

      <div class="popup-buttons" style="flex-wrap:wrap;">
        <button type="button" class="auth-button auth-button--secondary" id="syncNowBtn">Sync now</button>
        <button type="button" class="auth-button" id="reconnectCalendarBtn" style="${isError ? "" : "display:none;"}">Reconnect</button>
        <button type="button" class="auth-button auth-button--red" id="disconnectCalendarBtn">Disconnect</button>
      </div>

      <div class="popup-buttons">
        <button type="button" class="auth-button auth-button--secondary" id="closeManageCalendarBtn">Close</button>
      </div>
      `
    );

    DS.openPopup(overlay);

    overlay.querySelector("#closeManageCalendarBtn").addEventListener("click", () => DS.closePopup(overlay));
    overlay.querySelector("#syncNowBtn").addEventListener("click", () => syncCalendarNow(overlay));
    overlay.querySelector("#reconnectCalendarBtn").addEventListener("click", () => {
      startOAuthFlow(currentConnection.provider_id);
    });
    overlay.querySelector("#disconnectCalendarBtn").addEventListener("click", () => disconnectCalendar(overlay));
  }

  async function syncCalendarNow(overlay) {
    const messageEl = overlay.querySelector("#manageCalendarMessage");
    const btn = overlay.querySelector("#syncNowBtn");
    DS.setFormMessage(messageEl, "Syncing…", "");
    if (btn) btn.disabled = true;

    try {
      const anonKey = window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.anonKey;
      const res = await fetch(`${EDGE_FUNCTIONS_BASE_URL}/calendar-events-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey || "",
          Authorization: `Bearer ${anonKey || ""}`,
        },
        body: JSON.stringify({ user_id: DS.getUserId(currentProfile) }),
      });
      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        DS.setFormMessage(messageEl, result.error || "Sync failed. Try again.", "error");
        return;
      }

      const syncResult = (result.synced || [])[0];
      if (syncResult && syncResult.status === "error") {
        DS.setFormMessage(messageEl, syncResult.message || "Sync failed — the connection needs attention.", "error");
      } else {
        DS.setFormMessage(messageEl, "Synced!", "success");
      }

      // Pull the fresh status/event list into both the dashboard card and
      // this still-open modal (in case the sync just flipped the status,
      // e.g. connected -> error, or error -> connected after a token fix).
      await refreshCalendarCard();
      if (currentConnection) {
        const statusEl = overlay.querySelector("#manageCalendarStatus");
        if (statusEl) {
          statusEl.className = `status ${statusPillClass(currentConnection.status)}`;
          statusEl.textContent = statusPillText(currentConnection.status);
        }
        const reconnectBtn = overlay.querySelector("#reconnectCalendarBtn");
        if (reconnectBtn) {
          reconnectBtn.style.display = currentConnection.status === "error" ? "" : "none";
        }
      }
    } catch (err) {
      console.error("Manual calendar sync failed", err);
      DS.setFormMessage(messageEl, "Couldn't reach the server. Try again.", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function disconnectCalendar(overlay) {
    const messageEl = overlay.querySelector("#manageCalendarMessage");
    if (!window.confirm("Disconnect this calendar? You'll need to link it again to see events.")) return;

    try {
      const anonKey = window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.anonKey;
      const res = await fetch(`${EDGE_FUNCTIONS_BASE_URL}/calendar-disconnect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey || "",
          Authorization: `Bearer ${anonKey || ""}`,
        },
        body: JSON.stringify({
          user_id: DS.getUserId(currentProfile),
          provider_id: currentConnection.provider_id,
        }),
      });
      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        DS.setFormMessage(messageEl, result.error || "Couldn't disconnect. Try again.", "error");
        return;
      }

      DS.closePopup(overlay);
      await refreshCalendarCard();
    } catch (err) {
      console.error("Calendar disconnect failed", err);
      DS.setFormMessage(messageEl, "Couldn't reach the server. Try again.", "error");
    }
  }
})();