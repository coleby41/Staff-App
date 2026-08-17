// supabase/functions/reset-staff-password/index.ts
//
// Deploy: supabase functions deploy reset-staff-password
//
// Replaces staff-users.js's old direct `password_hash` update — after the
// Auth migration, writing password_hash no longer changes anyone's real
// login credential (login goes through Supabase Auth now, not that column),
// so that admin action would silently stop working correctly without this.
// Only IT / Super Admin may reset someone else's password; the target
// account is flagged must_reset_password so they immediately set their own
// on next login rather than keep using whatever IT just typed.
//
// POST body: { "staff_user_id": "...", "new_password": "..." }
// Response:  { "ok": true } or { "error": "..." }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function isItOrSuperAdmin(workgroup: unknown): boolean {
  const groups = (Array.isArray(workgroup) ? workgroup.map(String) : [String(workgroup ?? "")]).map((g) => g.trim());
  return groups.includes("IT") || groups.includes("Super Admin");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResponse({ error: "Missing Authorization header" }, 401);

  const { data: callerAuth, error: callerAuthError } = await supabaseAdmin.auth.getUser(jwt);
  if (callerAuthError || !callerAuth?.user) return jsonResponse({ error: "Not signed in" }, 401);

  const { data: callerStaff } = await supabaseAdmin
    .from("staff_users")
    .select("workgroup, active")
    .eq("auth_user_id", callerAuth.user.id)
    .maybeSingle();

  if (!callerStaff || callerStaff.active === false) return jsonResponse({ error: "Not authorized" }, 403);
  if (!isItOrSuperAdmin(callerStaff.workgroup)) {
    return jsonResponse({ error: "Only IT or Super Admin can reset another user's password." }, 403);
  }

  let body: { staff_user_id?: string; new_password?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const staffUserId = body.staff_user_id;
  const newPassword = body.new_password ?? "";
  if (!staffUserId || newPassword.length < 8) {
    return jsonResponse({ error: "staff_user_id is required and new_password must be at least 8 characters." }, 400);
  }

  const { data: targetStaff, error: targetError } = await supabaseAdmin
    .from("staff_users")
    .select("id, auth_user_id")
    .eq("id", staffUserId)
    .maybeSingle();

  if (targetError || !targetStaff || !targetStaff.auth_user_id) {
    return jsonResponse(
      { error: "That account hasn't been migrated to the new login system yet — run migrate-staff-to-auth.ts first." },
      404
    );
  }

  const { error: updateAuthError } = await supabaseAdmin.auth.admin.updateUserById(targetStaff.auth_user_id, {
    password: newPassword,
  });

  if (updateAuthError) {
    console.error("Failed to reset password:", updateAuthError);
    return jsonResponse({ error: "Couldn't reset that password. Try again." }, 500);
  }

  await supabaseAdmin.from("staff_users").update({ must_reset_password: true }).eq("id", targetStaff.id);

  return jsonResponse({ ok: true });
});
