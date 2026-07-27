// supabase/functions/calendar-disconnect/index.ts
//
// Deploy: supabase functions deploy calendar-disconnect --no-verify-jwt
//
// Removes a user's calendar connection (and its cached events) so they can
// relink cleanly from a known-good state. Used by the "Disconnect" button in
// the dashboard's Manage Calendar popup.
//
// The browser can't write to calendar_connections directly (no anon-role
// policy — see the SQL file), so this goes through the service_role key,
// same as calendar-oauth-callback and calendar-caldav-connect.
//
// ⚠️ Same trust limitation as the other calendar functions: user_id is
// whatever the browser sends, with no cryptographic proof it's really that
// user. See calendar-oauth-start/index.ts for the full note.
//
// POST body: { "user_id": "...", "provider_id": "google" | "microsoft" | "apple_caldav" }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: { user_id?: string; provider_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const { user_id, provider_id } = body;
  if (!user_id || !provider_id) {
    return jsonError("user_id and provider_id are both required", 400);
  }

  const { data: connection, error: fetchError } = await supabaseAdmin
    .from("calendar_connections")
    .select("id")
    .eq("user_id", user_id)
    .eq("provider_id", provider_id)
    .maybeSingle();

  if (fetchError) {
    console.error("Failed to look up calendar connection", fetchError);
    return jsonError("Couldn't look up that connection.", 500);
  }

  if (!connection) {
    // Already gone — treat as success so the UI can just move on.
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const { error: cacheError } = await supabaseAdmin
    .from("calendar_events_cache")
    .delete()
    .eq("connection_id", connection.id);

  if (cacheError) {
    // Not fatal — an orphaned cache row is harmless, and we still want the
    // connection itself removed so the user can relink.
    console.error("Failed to clear cached events for connection", connection.id, cacheError);
  }

  const { error: deleteError } = await supabaseAdmin
    .from("calendar_connections")
    .delete()
    .eq("id", connection.id);

  if (deleteError) {
    console.error("Failed to delete calendar connection", deleteError);
    return jsonError("Couldn't disconnect. Try again.", 500);
  }

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
