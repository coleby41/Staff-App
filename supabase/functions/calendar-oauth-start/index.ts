// supabase/functions/calendar-oauth-start/index.ts
//
// Deploy: supabase functions deploy calendar-oauth-start --no-verify-jwt
// (--no-verify-jwt because this portal doesn't use Supabase Auth, so there's
// no Supabase JWT to verify — see the RLS note in supabase-dashboard-setup.sql)
//
// Called by the browser as a plain link/redirect from the "Link Calendar"
// popup, e.g.:
//   GET /functions/v1/calendar-oauth-start?provider=google&user_id=<staff_users.id>
//
// Redirects the browser to Google/Microsoft's OAuth consent screen.
//
// ⚠️ KNOWN LIMITATION: because this portal has no server-side session/JWT,
// user_id here is whatever the browser sends — there's no cryptographic
// proof it's really that user. This mirrors the same app-level-trust model
// already accepted for RLS elsewhere in the portal (see the SQL file). If
// that's not acceptable for calendar data, the fix is the same one noted
// there: move staff_users onto real Supabase Auth.

import { getOAuthProviderConfig, encodeState, type OAuthProviderId } from "../_shared/provider-config.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") as OAuthProviderId | null;
  const userId = url.searchParams.get("user_id");

  if (!provider || !userId) {
    return new Response("Missing provider or user_id", { status: 400 });
  }
  if (provider !== "google" && provider !== "microsoft") {
    return new Response(`Unsupported provider: ${provider}`, { status: 400 });
  }

  const config = getOAuthProviderConfig(provider);
  if (!config.clientId || !config.redirectUri) {
    return new Response(
      `Calendar OAuth isn't configured for ${provider} yet (missing client id / redirect URI secret).`,
      { status: 500 }
    );
  }

  const state = encodeState({ provider, user_id: userId, nonce: crypto.randomUUID() });

  const authUrl = new URL(config.authEndpoint);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", config.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", config.scope);
  authUrl.searchParams.set("state", state);
  if (config.extraAuthParams) {
    for (const [key, value] of Object.entries(config.extraAuthParams)) {
      authUrl.searchParams.set(key, value);
    }
  }

  return Response.redirect(authUrl.toString(), 302);
});
