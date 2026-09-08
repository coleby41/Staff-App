-- Schedules the send-coi-reminders Edge Function to run once a day.
-- Run this AFTER: (1) supabase-coi-notifications-setup.sql has been run,
-- and (2) the send-coi-reminders function has been deployed with its
-- RESEND_API_KEY secret set (via `supabase functions deploy` + `supabase
-- secrets set`, or pasted into Dashboard -> Edge Functions).
--
-- Project ref is already filled in below: ostaqjuawieqpwuhrvsm
--
-- The service-role key is handled differently than the project ref --
-- it's NOT hardcoded in this file. That key bypasses every RLS policy in
-- the database, so it goes into Supabase's own Vault (a secrets store
-- built into the SQL Editor) instead of sitting in plain text in a cron
-- job definition or getting typed anywhere outside Supabase itself --
-- including never into a chat with Claude. This is a different, much
-- higher-stakes secret than the Resend API key (that one can only send
-- email through your Resend account; this one can read/write anything in
-- your database, full stop).
--
-- STEP 1 -- run this by itself first, in the SQL Editor, with your real
-- service-role key pasted directly into the SQL Editor's own text box
-- (Project Settings -> API -> service_role key -- the second, secret one,
-- not the public anon key):
--
--   select vault.create_secret(
--     '<PASTE-YOUR-SERVICE-ROLE-KEY-HERE>',
--     'coi_reminders_service_role_key'
--   );
--
-- Run that line once, then delete it (or just don't save it anywhere) --
-- the key is now stored encrypted in Vault under that name, and STEP 2
-- below reads it back by name rather than containing it directly.
--
-- STEP 2 -- everything below this point is safe to run as-is (no raw
-- secret in it) once STEP 1 above has been done.
--
-- Note on the schedule: pg_cron runs in UTC. '0 12 * * *' below is
-- 12:00 UTC = 8:00 AM Eastern during Daylight Time (roughly Mar-Nov) or
-- 7:00 AM Eastern during Standard Time (roughly Nov-Mar) -- Postgres
-- doesn't auto-adjust a plain UTC cron schedule for DST, so nudge this by
-- an hour twice a year if you want it to land at exactly 8:00 AM
-- year-round, or just leave it -- a 7-8am arrival either way is unlikely
-- to matter for this.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'send-coi-reminders-daily',
  '0 12 * * *',
  $$
  select net.http_post(
    url := 'https://ostaqjuawieqpwuhrvsm.supabase.co/functions/v1/send-coi-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'coi_reminders_service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To check it's registered:
--   select * from cron.job where jobname = 'send-coi-reminders-daily';
-- To see run history:
--   select * from cron.job_run_details order by start_time desc limit 20;
-- To remove it later:
--   select cron.unschedule('send-coi-reminders-daily');
-- To rotate the service-role key later (e.g. after regenerating it in
-- Project Settings -> API), update the Vault secret instead of touching
-- this file or the cron job at all:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'coi_reminders_service_role_key'),
--     '<NEW-SERVICE-ROLE-KEY>'
--   );
