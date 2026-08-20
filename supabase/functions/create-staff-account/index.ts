// supabase/functions/create-staff-account/index.ts
//
// Deploy: supabase functions deploy create-staff-account --no-verify-jwt
//
// 2026-08-19/20: THIS FLAG CHANGED. It used to be deployed WITHOUT
// --no-verify-jwt on the theory that Supabase's platform-level check (is
// there a real, valid session at all?) should happen before this code even
// runs, with the ROLE check done here. That reasoning turned out to be
// incompatible with the CORS fix above: a browser's OPTIONS preflight
// request never carries an Authorization header (that's inherent to how
// preflight works — it only *announces* which headers the real request
// will send), so with JWT verification left on, Supabase's own gateway
// rejects the preflight itself with 401 `{"code":"UNAUTHORIZED_NO_AUTH_HEADER"}`
// before this file's `if (req.method === "OPTIONS")` line ever gets a
// chance to run — this is exactly the 500/401 Coleby hit right after the
// CORS headers were added. Deploying with --no-verify-jwt removes that
// platform-level gate so the OPTIONS short-circuit below can actually
// execute; the real POST request still gets a full auth check, just done
// by THIS code (`supabaseAdmin.auth.getUser(jwt)` below, cryptographically
// verified against Supabase Auth) rather than the platform, so nothing
// about who can call this successfully has gotten looser — if anything
// it's stricter, since the platform gate alone never checked ROLE, only
// that a session existed. Same reasoning applies to reset-staff-password.
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
// 2026-08-20: the very first live account creation after the above fixes
// hit a 500 with Postgres error `null value in column "password_hash" of
// relation "staff_users" violates not-null constraint`. password_hash is
// legacy (real auth is Supabase Auth now) and never granted to any client
// role, but the column is still NOT NULL until it's dropped for good — see
// legacyPasswordHash() below for the fix (fills it with a real hash of the
// generated temp password rather than leaving it unset).
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

// staff_users.password_hash is legacy — real auth goes entirely through
// Supabase Auth now (see supabase-auth.js), and every client-facing grant on
// this column was already revoked (supabase-rls-lockdown.sql). It's slated to
// be dropped once the Auth migration is fully confirmed (see the
// commented-out `alter table ... drop column if exists password_hash;` near
// the bottom of that file) but hasn't been dropped yet, and the column is
// still NOT NULL — so inserting a brand-new staff_users row (unlike a
// migrated row, which already had a password_hash from before) fails with
// `null value in column "password_hash" of relation "staff_users" violates
// not-null constraint` unless something is written here. Filling it with a
// real SHA-256 hex hash of the actual temp password (same hex format
// staff-users.js's old client-side hashPassword() used, now dead code) keeps
// this harmless even if something unexpected reads the column before it's
// dropped — it's never treated as a source of truth for login either way.
async function legacyPasswordHash(password: string): Promise<string> {
  const bytes = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  // migrate-staff-to-auth.ts (staff-<staff_users.id>@...). password_hash is
  // legacy/unused (see legacyPasswordHash() above) but still NOT NULL, so it
  // has to be filled in here or this insert fails.
  const { data: newStaffRow, error: insertError } = await supabaseAdmin
    .from("staff_users")
    .insert({
      username,
      full_name,
      workgroup: [workgroup],
      active: true,
      must_reset_password: true,
      password_hash: await legacyPasswordHash(password),
    })
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
