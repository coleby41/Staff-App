/* ============================================================================
   quicklinks-card.js — "Quick Links" dashboard card
   Requires: dashboard-shared.js loaded first, and this markup in dashboard.html:

     <div class="card">
       <div class="card-header">
         <h2 class="card-title">Quick Links</h2>
       </div>
       <div id="quickLinksGrid" class="quick-links-grid"></div>
       <a href="#" id="editShortcutsLink" class="auth-link">Edit shortcuts</a>
     </div>

   Tables: public.quick_link_types (catalog, extensible), public.user_quick_links
   (each user's picks, max 6, enforced here in JS).

   ADDING A NEW SHORTCUT TYPE LATER: insert a row into quick_link_types (SQL),
   then add one entry to ICONS below if it needs a bespoke icon glyph — no
   other code changes required. That's the "future expansion" path the spec
   asked for.
============================================================================ */

(function () {
  "use strict";

  const DS = window.DashboardShared;
  const MAX_SHORTCUTS = 6;

  let currentProfile = null;
  let typeCatalog = []; // public.quick_link_types rows
  let userLinks = [];   // public.user_quick_links rows (joined)

  document.addEventListener("DOMContentLoaded", async () => {
    const gridEl = document.getElementById("quickLinksGrid");
    const editLink = document.getElementById("editShortcutsLink");
    if (!gridEl) return;

    currentProfile = await DS.getStaffProfile();

    const { data: types } = await DS.safeQuery(
      "load quick_link_types",
      window.supabaseClient
        .from("quick_link_types")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
    );
    typeCatalog = types || [];

    await loadUserLinks();

    if (editLink) {
      editLink.addEventListener("click", (e) => {
        e.preventDefault();
        openEditShortcutsModal();
      });
    }
  });

  async function loadUserLinks() {
    const gridEl = document.getElementById("quickLinksGrid");
    if (!currentProfile) {
      gridEl.innerHTML = `<p class="card-subtitle">Sign in to see your shortcuts.</p>`;
      return;
    }

    const { data, error } = await DS.safeQuery(
      "load user_quick_links",
      window.supabaseClient
        .from("user_quick_links")
        .select("*")
        .eq("user_id", DS.getUserId(currentProfile))
        .order("sort_order", { ascending: true })
        .limit(MAX_SHORTCUTS)
    );

    if (error) {
      gridEl.innerHTML = `<p class="card-subtitle">Couldn't load shortcuts.</p>`;
      return;
    }

    userLinks = data || [];
    renderGrid();
  }

  function resolveLinkDisplay(link) {
    const type = typeCatalog.find((t) => t.id === link.shortcut_type);
    if (!type) return null;

    if (type.requires_custom_url) {
      return {
        label: link.custom_label || "Custom Link",
        url: link.custom_url || "#",
        iconClass: type.icon_class,
      };
    }
    return {
      label: type.label,
      url: type.default_url,
      iconClass: type.icon_class,
    };
  }

  function renderGrid() {
    const gridEl = document.getElementById("quickLinksGrid");

    if (userLinks.length === 0) {
      gridEl.innerHTML = `<p class="card-subtitle">No shortcuts yet. Use "Edit shortcuts" to add up to ${MAX_SHORTCUTS}.</p>`;
      return;
    }

    gridEl.innerHTML = userLinks
      .slice(0, MAX_SHORTCUTS)
      .map((link) => {
        const display = resolveLinkDisplay(link);
        if (!display) return "";
        const isExternal = /^https?:\/\//i.test(display.url || "");
        return `
          <a class="quick-link-item" href="${DS.escapeHtml(display.url || "#")}" ${isExternal ? 'target="_blank" rel="noopener"' : ""}>
            <div class="quick-link-icon"><span class="${display.iconClass}"></span></div>
            <div class="quick-link-text">${DS.escapeHtml(display.label)}</div>
          </a>
        `;
      })
      .join("");
  }

  /* ------------------------------------------------------------------- */

  function openEditShortcutsModal() {
    const overlay = DS.buildPopup(
      "editShortcutsModal",
      `
      <h2>Edit shortcuts</h2>
      <p class="card-subtitle">Choose up to ${MAX_SHORTCUTS} shortcuts for your dashboard.</p>
      <div id="currentShortcutsList" class="equipment-list" style="margin:14px 0;"></div>

      <div class="auth-divider"></div>

      <form id="addShortcutForm" class="auth-form auth-form--compact">
        <h3>Add a shortcut</h3>
        <label class="auth-field">
          Type
          <select id="shortcutTypeSelect"></select>
        </label>
        <div id="customUrlFields" style="display:none;">
          <label class="auth-field">
            Label
            <input type="text" id="customLabelInput" maxlength="60" placeholder="e.g. Fleet Tracker" />
          </label>
          <label class="auth-field">
            URL
            <input type="url" id="customUrlInput" placeholder="https://" />
          </label>
        </div>
        <p id="shortcutMessage" class="auth-message"></p>
        <div class="popup-buttons">
          <button type="button" class="auth-button auth-button--secondary" id="closeEditShortcutsBtn">Done</button>
          <button type="submit" class="auth-button" id="addShortcutBtn">Add</button>
        </div>
      </form>
      `,
      { extraClass: "workbook-popup" }
    );

    populateTypeSelect(overlay);
    renderCurrentShortcuts(overlay);
    DS.openPopup(overlay);

    overlay.querySelector("#closeEditShortcutsBtn").addEventListener("click", () => DS.closePopup(overlay));

    overlay.querySelector("#shortcutTypeSelect").addEventListener("change", (e) => {
      const type = typeCatalog.find((t) => t.id === e.target.value);
      overlay.querySelector("#customUrlFields").style.display = type && type.requires_custom_url ? "block" : "none";
    });

    overlay.querySelector("#addShortcutForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleAddShortcut(overlay);
    });
  }

  function populateTypeSelect(overlay) {
    const select = overlay.querySelector("#shortcutTypeSelect");
    select.innerHTML = typeCatalog
      .map((t) => `<option value="${t.id}">${DS.escapeHtml(t.label)}</option>`)
      .join("");
  }

  function renderCurrentShortcuts(overlay) {
    const listEl = overlay.querySelector("#currentShortcutsList");
    const addBtn = overlay.querySelector("#addShortcutBtn");

    if (userLinks.length === 0) {
      listEl.innerHTML = `<p class="card-subtitle">No shortcuts saved yet.</p>`;
    } else {
      listEl.innerHTML = userLinks
        .map((link, index) => {
          const display = resolveLinkDisplay(link);
          if (!display) return "";
          return `
            <div class="equipment-item">
              <div>
                <h3>${DS.escapeHtml(display.label)}</h3>
                <p>${DS.escapeHtml(display.url || "")}</p>
              </div>
              <div style="display:flex; gap:6px;">
                <button type="button" class="workbook-btn workbook-btn--preview" data-move="up" data-index="${index}" ${index === 0 ? "disabled" : ""}>↑</button>
                <button type="button" class="workbook-btn workbook-btn--preview" data-move="down" data-index="${index}" ${index === userLinks.length - 1 ? "disabled" : ""}>↓</button>
                <button type="button" class="workbook-btn" style="background:var(--danger-soft); color:var(--danger);" data-remove="${link.id}">Remove</button>
              </div>
            </div>
          `;
        })
        .join("");
    }

    if (addBtn) addBtn.disabled = userLinks.length >= MAX_SHORTCUTS;

    listEl.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => removeShortcut(overlay, btn.dataset.remove));
    });
    listEl.querySelectorAll("[data-move]").forEach((btn) => {
      btn.addEventListener("click", () =>
        reorderShortcut(overlay, parseInt(btn.dataset.index, 10), btn.dataset.move)
      );
    });
  }

  async function handleAddShortcut(overlay) {
    const messageEl = overlay.querySelector("#shortcutMessage");

    if (userLinks.length >= MAX_SHORTCUTS) {
      DS.setFormMessage(messageEl, `You can only have ${MAX_SHORTCUTS} shortcuts. Remove one first.`, "error");
      return;
    }

    const typeId = overlay.querySelector("#shortcutTypeSelect").value;
    const type = typeCatalog.find((t) => t.id === typeId);
    if (!type) return;

    const payload = {
      user_id: DS.getUserId(currentProfile),
      shortcut_type: typeId,
      sort_order: userLinks.length,
      custom_label: null,
      custom_url: null,
    };

    if (type.requires_custom_url) {
      const label = overlay.querySelector("#customLabelInput").value.trim();
      const url = overlay.querySelector("#customUrlInput").value.trim();
      if (!label || !url) {
        DS.setFormMessage(messageEl, "Label and URL are required for a custom shortcut.", "error");
        return;
      }
      payload.custom_label = label;
      payload.custom_url = url;
    }

    const { error } = await DS.safeQuery(
      "add shortcut",
      window.supabaseClient.from("user_quick_links").insert(payload)
    );

    if (error) {
      DS.setFormMessage(messageEl, "Couldn't add that shortcut.", "error");
      return;
    }

    DS.setFormMessage(messageEl, "", "");
    overlay.querySelector("#addShortcutForm").reset();
    overlay.querySelector("#customUrlFields").style.display = "none";
    await loadUserLinks();
    renderCurrentShortcuts(overlay);
  }

  async function removeShortcut(overlay, linkId) {
    await DS.safeQuery(
      "remove shortcut",
      window.supabaseClient.from("user_quick_links").delete().eq("id", linkId)
    );
    await loadUserLinks();
    renderCurrentShortcuts(overlay);
  }

  async function reorderShortcut(overlay, index, direction) {
    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= userLinks.length) return;

    const a = userLinks[index];
    const b = userLinks[swapWith];

    await Promise.all([
      DS.safeQuery(
        "reorder shortcut",
        window.supabaseClient.from("user_quick_links").update({ sort_order: swapWith }).eq("id", a.id)
      ),
      DS.safeQuery(
        "reorder shortcut",
        window.supabaseClient.from("user_quick_links").update({ sort_order: index }).eq("id", b.id)
      ),
    ]);

    await loadUserLinks();
    renderCurrentShortcuts(overlay);
  }
})();