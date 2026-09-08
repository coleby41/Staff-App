-- Sends a one-time email the moment someone is added to OR removed from a
-- COI notification phase's recipient list -- follow-up to Coleby's
-- "add where it will send an email when your added to the list" (2026-09-04)
-- and, same day, "can we also see if we can add it where you get an email
-- if you are taken off the list?"
--
-- Implemented as a database trigger rather than a client-side call, so it
-- fires no matter how coi_notification_settings gets updated (the Vendors
-- page settings modal, a future admin tool, or a one-off SQL Editor
-- update) instead of only when that one modal's Save button is clicked.
--
-- Run this AFTER: supabase-coi-notifications-setup.sql AND
-- supabase-coi-notifications-cron-setup.sql's Vault step (Step 1 in that
-- file -- this trigger reuses the same 'coi_reminders_service_role_key'
-- Vault secret to call the Edge Function, so if that hasn't been created
-- yet, do that first). Also requires the send-coi-confirmation Edge
-- Function to be deployed (see delivery notes) -- if it isn't deployed
-- yet, this trigger will just fail its outbound calls silently (net.http_post
-- is fire-and-forget) rather than blocking anyone's settings save.
--
-- If you already ran an earlier version of this file (the "added" email
-- only, from earlier today): this is safe to run again. `create or replace
-- function` overwrites the same function name in place, and the trigger is
-- dropped and recreated the same way -- no separate cleanup needed.
--
-- This version also fixes a "one change, several emails" issue: the diff
-- below now normalizes (trims + lowercases) both the old and new email
-- lists before comparing them, so a stored address that differs only by
-- case or stray whitespace from what's being saved can't read as both
-- "removed" and "added" at once. The other half of that fix is on the
-- client (js/companies.js): Save now only writes the phase row(s) whose
-- list actually changed, instead of re-upserting all four phases on every
-- save -- so a phase nobody touched can no longer trip this trigger at all.

create or replace function public.coi_notify_new_recipients()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  added_emails text[];
  removed_emails text[];
  service_role_key text;
  recipient_email text;
begin
  -- Emails newly added compared to before -- on a fresh row (INSERT, e.g.
  -- the initial seed in the setup migration) there's no "before" to compare
  -- against, so everything currently in recipient_emails counts as added
  -- (in practice this is '{}' for the seed insert, so nothing actually
  -- fires from that). Nothing can be "removed" on an INSERT, since there's
  -- no prior list to have dropped anyone from.
  if TG_OP = 'INSERT' then
    select coalesce(array_agg(distinct trim(lower(e))), '{}') into added_emails
    from unnest(new.recipient_emails) as e
    where trim(e) <> '';
    removed_emails := '{}';
  else
    select coalesce(array_agg(e), '{}') into added_emails
    from (
      select distinct trim(lower(e)) as e
      from unnest(new.recipient_emails) as e
      where trim(e) <> ''
      except
      select distinct trim(lower(e))
      from unnest(old.recipient_emails) as e
      where trim(e) <> ''
    ) diff;

    select coalesce(array_agg(e), '{}') into removed_emails
    from (
      select distinct trim(lower(e)) as e
      from unnest(old.recipient_emails) as e
      where trim(e) <> ''
      except
      select distinct trim(lower(e))
      from unnest(new.recipient_emails) as e
      where trim(e) <> ''
    ) diff;
  end if;

  -- Nothing changed either direction (e.g. re-saving with no real edit) --
  -- skip the Vault lookup entirely rather than doing it for no reason.
  if (added_emails is null or array_length(added_emails, 1) is null)
     and (removed_emails is null or array_length(removed_emails, 1) is null) then
    return new;
  end if;

  select decrypted_secret into service_role_key
  from vault.decrypted_secrets
  where name = 'coi_reminders_service_role_key';

  -- Vault secret not set up yet -- don't fail the settings save over it,
  -- just skip sending (same "best effort" pattern send-coi-reminders
  -- already uses for individual send failures).
  if service_role_key is null then
    return new;
  end if;

  if added_emails is not null then
    foreach recipient_email in array added_emails loop
      perform net.http_post(
        url := 'https://ostaqjuawieqpwuhrvsm.supabase.co/functions/v1/send-coi-confirmation',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || service_role_key
        ),
        body := jsonb_build_object('email', recipient_email, 'phase', new.phase, 'action', 'added')
      );
    end loop;
  end if;

  if removed_emails is not null then
    foreach recipient_email in array removed_emails loop
      perform net.http_post(
        url := 'https://ostaqjuawieqpwuhrvsm.supabase.co/functions/v1/send-coi-confirmation',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || service_role_key
        ),
        body := jsonb_build_object('email', recipient_email, 'phase', new.phase, 'action', 'removed')
      );
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists coi_notification_settings_notify_new on public.coi_notification_settings;
create trigger coi_notification_settings_notify_new
  after insert or update of recipient_emails on public.coi_notification_settings
  for each row
  execute function public.coi_notify_new_recipients();

-- To test after everything's deployed: add a new email to any phase from
-- the Vendors page settings modal and save -- an "added" confirmation
-- should arrive within a few seconds. Remove that same email and save
-- again -- a "removed" notice should arrive. Re-saving with no actual
-- change to the list sends nothing either way.
--
-- To temporarily disable without dropping it:
--   alter table public.coi_notification_settings disable trigger coi_notification_settings_notify_new;
-- To re-enable:
--   alter table public.coi_notification_settings enable trigger coi_notification_settings_notify_new;
