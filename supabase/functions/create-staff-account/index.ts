// supabase/functions/create-staff-account/index.ts
//
// Deploy: supabase functions deploy create-staff-account
// (NO --no-verify-jwt here, unlike the calendar-* functions — we want
// Supabase's platform-level check that the caller has a real, valid session
// before this code even runs. We then check their ROLE ourselves below,
// since "signed in" and "allowed to create accounts" are different checks.)
//
// This is the ONLY way new staff accounts get created — replaces
// admin-users.js's old direct `staff_users` insert (which, under the old
// anon-open RLS, meant literally anyone with the anon key could create an
// account with any workgroup, including Super Admin). Only IT / Super Admin
// may call this; everyone else gets 403, enforced here server-side with the
// service-role key — not just hidden behind a UI check.
//
// 2026-08-19: no longer accepts a caller-supplied password. IT no longer
// types (and therefore never learns/reuses) a new hire's password — this
// generates a random one-time temp password the same way
// scripts/migrate-staff-to-auth.ts does, hands it back in the response
// exactly once so admin-users.js can display it for IT to relay out of
// band, and flags the account must_reset_password (already did) so the
// temp password stops working the moment the person sets their own.
//
// POST body: { "full_name": "...", "username": "...", "workgroup": "Office" }
// Response:  { "ok": true, "staff_user": { id, username, full_name, workgroup }, "temp_password": "..." }
//         or { "error": "..." }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AUTH_EMAIL_DOMAIN = "staffapp.internal"; // never shown in the UI — see supabase-auth.js

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// 2026-08-19: this is called with fetch() cross-origin (the app is served
// from stafftheleewardgroup.vercel.app, this function from
// ostaqjuawieqpwuhrvsm.supabase.co), and the request carries a custom
// Authorization header — that combination makes the browser send a
// preflight OPTIONS request first. Deno Edge Functions don't add CORS
// headers on their own; without them the browser blocks even a successful
// response (Coleby hit exactly this: "Response to preflight request
// doesn't pass access control check: It does not have HTTP ok status").
// Every response (including errors) needs these headers, and OPTIONS needs
// its own 200 short-circuit before any of the real logic below runs.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Same generator as scripts/migrate-staff-to-auth.ts's randomTempPassword():
// 16 random bytes -> base64url-ish, ~20 chars. Meets Supabase Auth's default
// password requirements; the person is forced to change it on first login
// (must_reset_password), so it never needs to be memorable.
function randomTempPassword(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "A").replace(/\//g, "B").replace(/=/g, "");
}

function asGroupList(workgroup: unknown): string[] {
  return Array.isArray(workgroup) ? workgroup.map(String) : [String(workgroup ?? "")];
}

function isItOrSuperAdmin(workgroup: unknown): boolean {
  const groups = asGroupList(workgroup).map((g) => g.trim());
  return groups.includes("IT") || groups.includes("Super Admin");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResponse({ error: "Missing Authorization header" }, 401);

  const { data: callerAuth, error: callerAuthError } = await supabaseAdmin.auth.getUser(jwt);
  if (callerAuthError || !callerAuth?.user) return jsonResponse({ error: "Not signed in" }, 401);

  const { data: callerStaff, error: callerStaffError } = await supabaseAdmin
    .from("staff_users")
    .select("id, workgroup, active")
    .eq("auth_user_id", callerAuth.user.id)
    .maybeSingle();

  if (callerStaffError || !callerStaff || callerStaff.active === false) {
    return jsonResponse({ error: "Not authorized" }, 403);
  }
  if (!isItOrSuperAdmin(callerStaff.workgroup)) {
    return jsonResponse({ error: "Only IT or Super Admin can create staff accounts." }, 403);
  }

  let body: { full_name?: string; username?: string; workgroup?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const full_name = (body.full_name ?? "").trim();
  const username = (body.username ?? "").trim();
  const workgroup = (body.workgroup ?? "Operations").trim();

  if (!full_name || !username) {
    return jsonResponse({ error: "full_name and username are both required." }, 400);
  }

  const password = randomTempPassword();

  const { data: existing } = await supabaseAdmin
    .from("staff_users")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (existing) return jsonResponse({ error: "That username is already taken." }, 409);

  // Insert the staff_users row first (without auth_user_id yet) so we have a
  // real id to build the synthetic email from — same convention as
  // migrate-staff-to-auth.ts (staff-<staff_users.id>@...).
  const { data: newStaffRow, error: insertError } = await supabaseAdmin
    .from("staff_users")
    .insert({ username, full_name, workgroup: [workgroup], active: true, must_reset_password: true })
    .select("id")
    .single();

  if (insertError || !newStaffRow) {
    console.error("Failed to insert staff_users row:", insertError);
    const isDup = insertError?.code === "23505";
    return jsonResponse({ error: isDup ? "That username is already taken." : "Couldn't create that account. Try again." }, isDup ? 409 : 500);
  }

  const authEmail = `staff-${newStaffRow.id}@${AUTH_EMAIL_DOMAIN}`;

  const { data: createdAuthUser, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
    email: authEmail,
    password,
    email_confirm: true, // synthetic address, nothing to actually confirm
  });

  if (createAuthError || !createdAuthUser?.user) {
    console.error("Failed to create auth user:", createAuthError);
    await supabaseAdmin.from("staff_users").delete().eq("id", newStaffRow.id); // roll back, avoid an orphan row
    return jsonResponse({ error: "Couldn't create that account. Try again." }, 500);
  }

  const { error: linkError } = await supabaseAdmin
    .from("staff_users")
    .update({ auth_user_id: createdAuthUser.user.id, auth_email: authEmail })
    .eq("id", newStaffRow.id);

  if (linkError) {
    console.error("Created the account but failed to link it:", linkError);
    return jsonResponse({ error: "Account created but something went wrong finishing setup — contact IT." }, 500);
  }

  return jsonResponse({
    ok: true,
    staff_user: { id: newStaffRow.id, username, full_name, workgroup: [workgroup] },
    temp_password: password,
  });
});
