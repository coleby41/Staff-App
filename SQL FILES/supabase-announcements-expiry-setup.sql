-- ============================================================================
-- announcements.expires_at — powers the Temporary/Long-term choice on the
-- "Send Announcement" card (payroll-tools.html).
--
-- Temporary announcements are inserted with expires_at = created_at + 24h.
-- Long-term announcements are inserted with expires_at = null and never expire
-- on their own.
--
-- There's no background cron here — cleanup is opportunistic: every place
-- that reads the announcements table (payroll-tools.html, timesheet.js on the
-- Staff Finance page) first deletes any row whose expires_at has passed,
-- then selects. So an expired temporary announcement disappears the next
-- time anyone loads a page that shows announcements, without needing
-- pg_cron or an Edge Function.
-- ============================================================================

alter table public.announcements
  add column if not exists expires_at timestamptz;

create index if not exists announcements_expires_at_idx on public.announcements (expires_at);
