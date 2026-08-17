// scripts/migrate-staff-to-auth.ts
//
// STEP 2 of the security re-architecture. Run this ONCE, by hand, after
// SQL FILES/supabase-auth-rearchitecture-schema.sql has been run and BEFORE
// SQL FILES/supabase-project-members-backfill.sql / supabase-rls-lockdown.sql.
//
// What it does: for every staff_users row that doesn't yet have an
// auth_user_id, creates a real Supabase Auth user (auth.admin.createUser())
// with a synthetic, never-shown email and a random one-time password, links
// it back onto staff_users (auth_user_id, auth_email), sets
// must_reset_password = true, and prints the temp password ONCE so you can
// hand it to that person out of band (Slack DM, in person, etc. — NOT
// email, since the synthetic address isn't a real inbox). The existing
// SHA-256 password_hash can't be reversed into the person's real password,
// which is why this issues a fresh temp password rather than trying to
// preserve the old one — everyone effectively gets a "your password was
// reset, here's a temporary one" on this migration, same as the
// create-staff-account Edge Function does for brand-new hires going forward.
//
// ⚠️ Uses the service-role key. Never run this from a browser, never commit
// the key, never put it in a client-side file. Run it locally:
//
//   SUPABASE_URL=https://ostaqjuawieqpwuhrvsm.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service role key, from Supabase → Project Settings → API> \
//   deno run --allow-net --allow-env scripts/migrate-staff-to-auth.ts
//
// Safe to re-run: it only processes rows where auth_user_id is still null,
// so anyone already migrated is skipped.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.");
  Deno.exit(1);
}

const AUTH_EMAIL_DOMAIN = "staffapp.internal"; // never shown in the UI — see supabase-auth.js

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function randomTempPassword(): string {
  // 16 random bytes -> base64url, trimmed to a clean 20-ish char password.
  // Meets Supabase Auth's default password requirements; the person is
  // forced to change it on first login (must_reset_password), so this
  // never needs to be memorable.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "A").replace(/\//g, "B").replace(/=/g, "");
}

async function main() {
  const { data: rows, error } = await supabaseAdmin
    .from("staff_users")
    .select("id, username, full_name, active")
    .is("auth_user_id", null);

  if (error) {
    console.error("Failed to load staff_users:", error);
    Deno.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log("Nothing to migrate — every staff_users row already has an auth_user_id.");
    return;
  }

  console.log(`Migrating ${rows.length} staff_users row(s) to real Supabase Auth accounts...\n`);

  const results: { username: string; full_name: string; temp_password: string; active: boolean }[] = [];

  for (const row of rows) {
    // Synthetic email is derived from the row's own id (guaranteed unique,
    // unlike sanitizing an arbitrary username into an email local-part) —
    // never shown to the person; they keep logging in with their username.
    const authEmail = `staff-${row.id}@${AUTH_EMAIL_DOMAIN}`;
    const tempPassword = randomTempPassword();

    const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: authEmail,
      password: tempPassword,
      email_confirm: true, // synthetic address, nothing to actually confirm
    });

    if (createError || !created?.user) {
      console.error(`FAILED for username "${row.username}" (staff_users.id=${row.id}):`, createError);
      continue;
    }

    const { error: updateError } = await supabaseAdmin
      .from("staff_users")
      .update({
        auth_user_id: created.user.id,
        auth_email: authEmail,
        must_reset_password: true,
      })
      .eq("id", row.id);

    if (updateError) {
      console.error(`Created the auth user for "${row.username}" but failed to link it back:`, updateError);
      // Clean up the orphaned auth user so a re-run doesn't collide.
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      continue;
    }

    results.push({
      username: row.username,
      full_name: row.full_name ?? "",
      temp_password: tempPassword,
      active: row.active !== false,
    });
  }

  console.log("\nDone. Temporary passwords (hand these out individually, NOT as one shared list —");
  console.log("this printout is the only place this password is ever visible):\n");
  console.table(results);
  console.log(
    "\nEveryone above is flagged must_reset_password=true — they'll be forced to set their own " +
    "password immediately after their first successful login with the temp one."
  );
}

await main();
