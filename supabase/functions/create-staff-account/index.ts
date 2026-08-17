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
// POST body: { "full_name": "...", "username": "...", "password": "...", "workgroup": "Office" }
// Response:  { "ok": true, "staff_user": { id, username, full_name, workgroup } }
//         or { "error": "..." }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AUTH_EMAIL_DOMAIN = "staffapp.internal"; // never shown in the UI — see supabase-auth.js

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function asGroupList(workgroup: unknown): string[] {
  return Array.isArray(workgroup) ? workgroup.map(String) : [String(workgroup ?? "")];
}

function isItOrSuperAdmin(workgroup: unknown): boolean {
  const groups = asGroupList(workgroup).map((g) => g.trim());
  return groups.includes("IT") || groups.includes("Super Admin");
}

Deno.serve(async (req) => {
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

  let body: { full_name?: string; username?: string; password?: string; workgroup?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const full_name = (body.full_name ?? "").trim();
  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  const workgroup = (body.workgroup ?? "Operations").trim();

  if (!full_name || !username || !password) {
    return jsonResponse({ error: "full_name, username, and password are all required." }, 400);
  }
  if (password.length < 8) {
    return jsonResponse({ error: "Password must be at least 8 characters." }, 400);
  }

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
  });
});
