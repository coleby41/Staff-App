// supabase/functions/calendar-caldav-connect/index.ts
//
// Deploy: supabase functions deploy calendar-caldav-connect --no-verify-jwt
//
// Apple Calendar has no OAuth — the user generates an app-specific password
// at appleid.apple.com and gives it to us directly (same pattern every
// third-party CalDAV client uses for iCloud). This function:
//   1. Verifies the credentials work with a lightweight PROPFIND against
//      iCloud's CalDAV server.
//   2. Stores them in calendar_connections via the service_role key (the
//      browser can't write to this table directly — see the SQL file).
//   3. Triggers an initial sync.
//
// POST body: { "user_id": "...", "username": "you@icloud.com", "app_password": "xxxx-xxxx-xxxx-xxxx" }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: { user_id?: string; username?: string; app_password?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { user_id, username, app_password } = body;
  if (!user_id || !username || !app_password) {
    return jsonError("user_id, username, and app_password are all required", 400);
  }

  const auth = "Basic " + btoa(`${username}:${app_password}`);
  const verifyRes = await fetch("https://caldav.icloud.com/", {
    method: "PROPFIND",
    headers: { Authorization: auth, Depth: "0", "Content-Type": "application/xml" },
    body: `<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`,
  });

  if (verifyRes.status === 401 || verifyRes.status === 403) {
    return jsonError("Apple rejected that username/app-specific password.", 401);
  }
  if (!verifyRes.ok) {
    return jsonError(`Couldn't verify Apple Calendar credentials (status ${verifyRes.status}).`, 502);
  }

  const { error } = await supabaseAdmin.from("calendar_connections").upsert(
    {
      user_id,
      provider_id: "apple_caldav",
      status: "connected",
      external_account_email: username,
      caldav_username: username,
      caldav_app_password: app_password,
    },
    { onConflict: "user_id,provider_id" }
  );

  if (error) {
    console.error("Failed to store CalDAV connection", error);
    return jsonError("Verified, but couldn't save the connection. Try again.", 500);
  }

  fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/calendar-events-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify({ user_id }),
  }).catch((err) => console.error("Initial CalDAV sync trigger failed", err));

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
