/* ============================================================================
   updates-card.js — "Company Updates" dashboard card
   Requires this markup in dashboard.html (note: no "View all" link per spec):

     <div class="card">
       <div class="card-header">
         <h2 class="card-title">📣 Company Updates</h2>
       </div>
       <div id="companyUpdatesList" class="info-list"></div>
       <button type="button" id="makeUpdateBtn" class="auth-link" style="display:none; background:none; border:none; padding:0; cursor:pointer;">
         Make a Company Update
       </button>
     </div>

   Table: public.company_updates (title, description, author_id, author_name)

   PERMISSIONS NOTE: "Only Super Admin / Owner / IT may create updates" is
   enforced here by hiding/disabling the button for other roles. Because this
   portal's custom auth means there's no server-side identity (see
   supabase-dashboard-setup.sql comments), this is a UI-level gate only —
   not a database-enforced one.
============================================================================ */

(function () {
  "use strict";

  const DS = window.DashboardShared;
  const ALLOWED_ROLES = ["Super Admin", "Owner", "IT"];
  const MAX_UPDATES_SHOWN = 5;

  let currentProfile = null;

  document.addEventListener("DOMContentLoaded", async () => {
    const listEl = document.getElementById("companyUpdatesList");
    if (!listEl) return;

    currentProfile = await DS.getStaffProfile();

    await loadUpdates();

    const makeUpdateBtn = document.getElementById("makeUpdateBtn");
    if (makeUpdateBtn) {
      const canPost = DS.userHasAnyRole(currentProfile, ALLOWED_ROLES);
      makeUpdateBtn.style.display = canPost ? "inline-flex" : "none";
      makeUpdateBtn.addEventListener("click", openMakeUpdateModal);
    }
  });

  async function loadUpdates() {
    const listEl = document.getElementById("companyUpdatesList");

    const { data, error } = await DS.safeQuery(
      "load company_updates",
      window.supabaseClient
        .from("company_updates")
        .select("id, title, description, author_name, created_at")
        .order("created_at", { ascending: false })
        .limit(MAX_UPDATES_SHOWN)
    );

    if (error) {
      listEl.innerHTML = `<p class="card-subtitle">Couldn't load updates.</p>`;
      return;
    }

    if (!data || data.length === 0) {
      listEl.innerHTML = `<p class="card-subtitle">No updates yet.</p>`;
      return;
    }

    listEl.innerHTML = data
      .map(
        (u) => `
        <div class="info-item" style="align-items:flex-start; flex-direction:column; gap:4px;">
          <h3>${DS.escapeHtml(u.title)}</h3>
          <p>${DS.escapeHtml(u.description)}</p>
          <p style="font-size:0.78rem; color:var(--text-soft);">${relativeTime(u.created_at)}</p>
        </div>
      `
      )
      .join("");
  }

  function relativeTime(isoString) {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffMins = Math.round(diffMs / 60000);
    if (diffMins < 60) return diffMins <= 1 ? "just now" : `${diffMins} minutes ago`;
    const diffHours = Math.round(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
    const diffDays = Math.round(diffHours / 24);
    if (diffDays < 14) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
    const diffWeeks = Math.round(diffDays / 7);
    return `${diffWeeks} week${diffWeeks === 1 ? "" : "s"} ago`;
  }

  function openMakeUpdateModal() {
    const overlay = DS.buildPopup(
      "makeUpdateModal",
      `
      <h2>Make a company update</h2>
      <form id="makeUpdateForm" class="auth-form">
        <label class="auth-field">
          Update title
          <input type="text" id="updateTitleInput" required maxlength="120" />
        </label>
        <label class="auth-field">
          Update description
          <textarea id="updateDescriptionInput" required></textarea>
        </label>
        <p id="makeUpdateMessage" class="auth-message"></p>
        <div class="popup-buttons">
          <button type="button" class="auth-button auth-button--secondary" id="cancelMakeUpdateBtn">Cancel</button>
          <button type="submit" class="auth-button">Post update</button>
        </div>
      </form>
      `
    );

    DS.openPopup(overlay);
    overlay.querySelector("#cancelMakeUpdateBtn").addEventListener("click", () => DS.closePopup(overlay));

    overlay.querySelector("#makeUpdateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const messageEl = overlay.querySelector("#makeUpdateMessage");
      const title = overlay.querySelector("#updateTitleInput").value.trim();
      const description = overlay.querySelector("#updateDescriptionInput").value.trim();

      if (!title || !description) {
        DS.setFormMessage(messageEl, "Title and description are required.", "error");
        return;
      }

      const authorName = currentProfile?.full_name || currentProfile?.username || "Staff";

      const { error } = await DS.safeQuery(
        "create company update",
        window.supabaseClient.from("company_updates").insert({
          title,
          description,
          author_id: DS.getUserId(currentProfile),
          author_name: authorName,
        })
      );

      if (error) {
        DS.setFormMessage(messageEl, "Couldn't post that update. Try again.", "error");
        return;
      }

      DS.closePopup(overlay);
      loadUpdates();
    });
  }
})();