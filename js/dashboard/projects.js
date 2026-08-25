/* ============================================================================
   projects-card.js — "Project Snapshot" dashboard card
   Requires this markup in dashboard.html:

     <div class="card">
       <div class="card-header">
         <h2 class="card-title">📈 Project Snapshot</h2>
         <a href="/pages/projects.html" class="chip">View all projects</a>
       </div>
       <div class="stats-grid" style="grid-template-columns: repeat(2, 1fr);">
         <div class="stat-item">
           <div class="stat-number-status-projector" id="activeProjectsCount">—</div>
           <div class="stat-label">Active Projects</div>
         </div>
       </div>
       <h3 style="margin:16px 0 8px;">Upcoming Deadlines</h3>
       <div id="upcomingDeadlinesList" class="info-list"></div>
     </div>

   ⚠️ SCHEMA ASSUMPTION — I don't have visibility into your existing
   Supabase project tables, but the screenshot clearly shows real project
   data (18 Active Projects, named deadlines with site addresses) that must
   already live somewhere in your database. This file queries the following
   assumed shape:

     public.projects
       id, name, is_active (boolean)

     public.project_deadlines
       id, project_id (FK -> projects.id), title, site, deadline_date (date)

   If your real table/column names differ, tell me what they are and I'll
   update the two queries below (loadActiveProjectCount / loadUpcomingDeadlines)
   — nothing else in this file needs to change.
============================================================================ */

(function () {
  "use strict";

  const DS = window.DashboardShared;
  const MAX_DEADLINES = 6;

  document.addEventListener("DOMContentLoaded", async () => {
    const countEl = document.getElementById("activeProjectsCount");
    const deadlinesEl = document.getElementById("upcomingDeadlinesList");
    if (!countEl && !deadlinesEl) return;

    if (countEl) loadActiveProjectCount(countEl);
    if (deadlinesEl) loadUpcomingDeadlines(deadlinesEl);
  });

  async function loadActiveProjectCount(countEl) {
    const { count, error } = await window.supabaseClient
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);

    if (error) {
      console.error("projects-card: failed to load active project count", error);
      countEl.textContent = "—";
      return;
    }
    countEl.textContent = count ?? 0;
  }

  async function loadUpcomingDeadlines(deadlinesEl) {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const todayStr = today.toISOString().slice(0, 10);
    const endOfMonthStr = endOfMonth.toISOString().slice(0, 10);

    const { data, error } = await DS.safeQuery(
      "load project_deadlines",
      window.supabaseClient
        .from("project_deadlines")
        .select("id, title, site, deadline_date, projects(name)")
        .gte("deadline_date", todayStr)
        .lte("deadline_date", endOfMonthStr)
        .order("deadline_date", { ascending: true })
        .limit(MAX_DEADLINES)
    );

    if (error) {
      deadlinesEl.innerHTML = `<p class="card-subtitle">Couldn't load upcoming deadlines.</p>`;
      return;
    }

    if (!data || data.length === 0) {
      deadlinesEl.innerHTML = `<p class="card-subtitle">No deadlines remaining this month.</p>`;
      return;
    }

    deadlinesEl.innerHTML = data
      .map((d) => {
        const date = new Date(d.deadline_date + "T00:00:00");
        const month = date.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
        const day = date.getDate();
        return `
          <div class="info-item">
            <div style="display:flex; gap:12px; align-items:center;">
              <div style="text-align:center; min-width:44px;">
                <div style="font-size:0.7rem; font-weight:700; color:var(--text-soft);">${month}</div>
                <div style="font-size:1.05rem; font-weight:700; color:var(--accent-strong);">${day}</div>
              </div>
              <div>
                <h3>${DS.escapeHtml(d.title)}</h3>
                <p>${DS.escapeHtml(d.site || d.projects?.name || "")}</p>
              </div>
            </div>
          </div>
        `;
      })
      .join("");
  }
})();