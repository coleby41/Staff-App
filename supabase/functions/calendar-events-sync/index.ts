// supabase/functions/calendar-events-sync/index.ts
//
// Deploy: supabase functions deploy calendar-events-sync --no-verify-jwt
//
// POST { "user_id": "<staff_users.id>" }  -> syncs just that user's connections
// POST {}                                  -> syncs every active connection
//                                             (handy as a scheduled job, see
//                                             below)
//
// For each connection: refreshes the access token if it's expired (OAuth2
// providers only), pulls upcoming events from the provider, and upserts
// them into public.calendar_events_cache so the dashboard never talks to
// Google/Microsoft/Apple directly (and never sees tokens).
//
// SCHEDULING: to keep the cache fresh without the user reloading the page,
// call this on a schedule with Supabase's pg_cron + pg_net, e.g. every 15
// minutes:
//   select cron.schedule('sync-calendars', '*/15 * * * *', $$
//     select net.http_post(
//       url := '<your-project-ref>.functions.supabase.co/calendar-events-sync',
//       headers := jsonb_build_object('Authorization', 'Bearer <service_role_key>'),
//       body := '{}'::jsonb
//     );
//   $$);
//
// ⚠️ Apple/CalDAV sync below is a best-effort minimal ICS parser (handles
// non-recurring VEVENTs). Recurring events (RRULE) aren't expanded — treat
// this as a working starting point, not a complete CalDAV client.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getOAuthProviderConfig, type OAuthProviderId } from "../_shared/provider-config.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  let body: { user_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — means "sync everyone" */
  }

  let query = supabaseAdmin.from("calendar_connections").select("*").eq("status", "connected");
  if (body.user_id) query = query.eq("user_id", body.user_id);

  const { data: connections, error } = await query;
  if (error) {
    console.error("Failed to load calendar_connections", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results = [];
  for (const connection of connections ?? []) {
    try {
      if (connection.provider_id === "google" || connection.provider_id === "microsoft") {
        await syncOAuthConnection(connection);
      } else if (connection.provider_id === "apple_caldav") {
        await syncCalDavConnection(connection);
      }
      results.push({ connection_id: connection.id, status: "ok" });
    } catch (err) {
      console.error(`Sync failed for connection ${connection.id}`, err);
      await supabaseAdmin.from("calendar_connections").update({ status: "error" }).eq("id", connection.id);
      results.push({ connection_id: connection.id, status: "error", message: String(err) });
    }
  }

  return new Response(JSON.stringify({ synced: results }), {
    headers: { "Content-Type": "application/json" },
  });
});

/* --------------------------------------------------------------------- */

async function syncOAuthConnection(connection: any) {
  const provider = connection.provider_id as OAuthProviderId;
  const accessToken = await ensureFreshAccessToken(connection);

  const events =
    provider === "google" ? await fetchGoogleEvents(accessToken) : await fetchMicrosoftEvents(accessToken);

  await upsertEvents(connection, events);
}

async function ensureFreshAccessToken(connection: any): Promise<string> {
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 60_000) {
    return connection.access_token;
  }
  if (!connection.refresh_token) {
    return connection.access_token; // best effort — may fail downstream if truly expired
  }

  const config = getOAuthProviderConfig(connection.provider_id as OAuthProviderId);
  const res = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const tokens = await res.json();
  const newExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await supabaseAdmin
    .from("calendar_connections")
    .update({
      access_token: tokens.access_token,
      token_expires_at: newExpiresAt,
      // Google/Microsoft don't always return a new refresh_token — keep the old one if absent.
      refresh_token: tokens.refresh_token ?? connection.refresh_token,
    })
    .eq("id", connection.id);

  return tokens.access_token;
}

async function fetchGoogleEvents(accessToken: string) {
  const timeMin = new Date().toISOString();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("maxResults", "20");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google events fetch failed: ${await res.text()}`);
  const data = await res.json();

  return (data.items ?? []).map((item: any) => ({
    external_event_id: item.id,
    title: item.summary ?? "(No title)",
    start_time: item.start?.dateTime ?? item.start?.date,
    end_time: item.end?.dateTime ?? item.end?.date ?? null,
    location: item.location ?? null,
  }));
}

async function fetchMicrosoftEvents(accessToken: string) {
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const url = new URL(
    `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${now.toISOString()}&endDateTime=${future.toISOString()}`
  );
  url.searchParams.set("$top", "20");
  url.searchParams.set("$orderby", "start/dateTime");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' },
  });
  if (!res.ok) throw new Error(`Microsoft events fetch failed: ${await res.text()}`);
  const data = await res.json();

  return (data.value ?? []).map((item: any) => ({
    external_event_id: item.id,
    title: item.subject ?? "(No title)",
    start_time: item.start?.dateTime ? `${item.start.dateTime}Z` : null,
    end_time: item.end?.dateTime ? `${item.end.dateTime}Z` : null,
    location: item.location?.displayName ?? null,
  }));
}

/* --------------------------------------------------------------------- */
/* Apple Calendar via CalDAV (best-effort — see file header note)         */

async function syncCalDavConnection(connection: any) {
  if (!connection.caldav_username || !connection.caldav_app_password) {
    throw new Error("Missing CalDAV credentials");
  }

  const auth = "Basic " + btoa(`${connection.caldav_username}:${connection.caldav_app_password}`);
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const reportBody = `<?xml version="1.0" encoding="utf-8" ?>
    <C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
      <D:prop><D:getetag/><C:calendar-data/></D:prop>
      <C:filter>
        <C:comp-filter name="VCALENDAR">
          <C:comp-filter name="VEVENT">
            <C:time-range start="${toCalDavDate(now)}" end="${toCalDavDate(future)}"/>
          </C:comp-filter>
        </C:comp-filter>
      </C:filter>
    </C:calendar-query>`;

  const res = await fetch("https://caldav.icloud.com/", {
    method: "REPORT",
    headers: { Authorization: auth, "Content-Type": "application/xml; charset=utf-8", Depth: "1" },
    body: reportBody,
  });

  if (!res.ok) throw new Error(`CalDAV REPORT failed: ${res.status}`);
  const xml = await res.text();
  const events = parseIcsEventsFromCalDavResponse(xml);
  await upsertEvents(connection, events);
}

function toCalDavDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function parseIcsEventsFromCalDavResponse(xml: string) {
  const events: any[] = [];
  const veventBlocks = xml.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];

  for (const block of veventBlocks) {
    const uid = block.match(/UID:(.*)/)?.[1]?.trim();
    const summary = block.match(/SUMMARY:(.*)/)?.[1]?.trim();
    const dtstart = block.match(/DTSTART[^:]*:(.*)/)?.[1]?.trim();
    const dtend = block.match(/DTEND[^:]*:(.*)/)?.[1]?.trim();
    const location = block.match(/LOCATION:(.*)/)?.[1]?.trim();

    if (!uid || !dtstart) continue;

    events.push({
      external_event_id: uid,
      title: summary || "(No title)",
      start_time: parseIcsDate(dtstart),
      end_time: dtend ? parseIcsDate(dtend) : null,
      location: location || null,
    });
  }

  return events;
}

function parseIcsDate(raw: string): string {
  // Handles basic forms: 20250101T120000Z or 20250101
  if (/^\d{8}T\d{6}Z?$/.test(raw)) {
    const iso = raw.replace(
      /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/,
      "$1-$2-$3T$4:$5:$6Z"
    );
    return iso;
  }
  if (/^\d{8}$/.test(raw)) {
    return raw.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3T00:00:00Z");
  }
  return raw;
}

/* --------------------------------------------------------------------- */

async function upsertEvents(connection: any, events: any[]) {
  if (events.length === 0) return;

  const rows = events
    .filter((e) => e.start_time)
    .map((e) => ({
      user_id: connection.user_id,
      connection_id: connection.id,
      external_event_id: e.external_event_id,
      title: e.title,
      start_time: e.start_time,
      end_time: e.end_time,
      location: e.location,
      synced_at: new Date().toISOString(),
    }));

  const { error } = await supabaseAdmin
    .from("calendar_events_cache")
    .upsert(rows, { onConflict: "connection_id,external_event_id" });

  if (error) throw error;
}
