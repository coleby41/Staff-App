/* ============================================================================
   contacts-card.js — "Important Contacts" dashboard card
   Requires this markup in dashboard.html:

     <div class="card">
       <div class="card-header">
         <h2 class="card-title">📞 Important Contacts</h2>
       </div>
       <div id="importantContactsList" class="info-list"></div>
     </div>

   No Supabase table, no separate data file — this list is edited by hand
   directly below. Add, remove, or reorder entries in the importantContacts
   array and reload the page.
============================================================================ */

const importantContacts = [

    {
        name: 'Barry Coppedge',
        jobTitle: 'Co-Owner',
        phone: 'N/A'
    },

    {
        name: 'Ashley Coppedge',
        jobTitle: 'Office Manager',
        phone: 'N/A'
    },

    {
        name: 'Rodney Williams',
        jobTitle: 'Co-Owner',
        phone: 'N/A'
    },

    {
        name: 'Coleby Ludwig',
        jobTitle: 'Data Coordinator/IT',
        phone: 'N/A'
    },

];

(function () {
    "use strict";

    const DS = window.DashboardShared;

    document.addEventListener("DOMContentLoaded", () => {
        const listEl = document.getElementById("importantContactsList");
        if (!listEl) return;

        if (importantContacts.length === 0) {
            listEl.innerHTML = `<p class="card-subtitle">No contacts added yet.</p>`;
            return;
        }

        listEl.innerHTML = importantContacts
            .map(
                (c) => `
        <div class="info-item">
          <div>
            <h3>${DS.escapeHtml(c.name)}</h3>
            <p>${DS.escapeHtml(c.jobTitle)}</p>
            <p>${DS.escapeHtml(c.phone)}</p>
          </div>
          <a class="status connected" href="tel:${DS.escapeHtml(c.phone.replace(/[^\d+]/g, ""))}" aria-label="Call ${DS.escapeHtml(c.name)}">📞</a>
        </div>
      `
            )
            .join("");
    });
})();