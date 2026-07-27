// supabase/functions/calendar-oauth-callback/index.ts
//
// Deploy: supabase functions deploy calendar-oauth-callback --no-verify-jwt
//
// This is the redirect_uri registered with Google/Microsoft. It:
//   1. Reads `code` and `state` from the query string.
//   2. Exchanges the code for access_token/refresh_token.
//   3. Upserts the tokens into public.calendar_connections using the
//      service_role key (bypasses RLS — this table intentionally has no
//      anon-accessible policy, see supabase-dashboard-setup.sql).
//   4. Redirects the browser back to dashboard.html so the user lands back
//      in the app.
//
// Required secrets (see _shared/provider-config.ts for the full list):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase),
//   GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI, MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI,
//   SITE_URL

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getOAuthProviderConfig, decodeState, getSiteUrl, type OAuthProviderId } from "../_shared/provider-config.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const siteUrl = getSiteUrl();

  if (!code || !stateParam) {
    return redirectWithStatus(siteUrl, "error", "missing_code_or_state");
  }

  let provider: OAuthProviderId;
  let userId: string;
  try {
    const state = decodeState(stateParam);
    provider = state.provider as OAuthProviderId;
    userId = state.user_id as string;
  } catch {
    return redirectWithStatus(siteUrl, "error", "invalid_state");
  }

  const config = getOAuthProviderConfig(provider);

  try {
    const tokenRes = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      console.error("Token exchange failed", await tokenRes.text());
      return redirectWithStatus(siteUrl, "error", "token_exchange_failed");
    }

    const tokens = await tokenRes.json();
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    const accountEmail = await fetchAccountEmail(provider, tokens.access_token);

    const { error } = await supabaseAdmin.from("calendar_connections").upsert(
      {
        user_id: userId,
        provider_id: provider,
        status: "connected",
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        token_expires_at: expiresAt,
        external_account_email: accountEmail,
      },
      { onConflict: "user_id,provider_id" }
    );

    if (error) {
      console.error("Failed to store calendar connection", error);
      return redirectWithStatus(siteUrl, "error", "storage_failed");
    }

    // Kick off an initial sync so events show up right away. Fire-and-forget —
    // don't block the redirect on it.
    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/calendar-events-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({ user_id: userId }),
    }).catch((err) => console.error("Initial sync trigger failed", err));

    return redirectWithStatus(siteUrl, "success", provider);
  } catch (err) {
    console.error("calendar-oauth-callback error", err);
    return redirectWithStatus(siteUrl, "error", "unexpected");
  }
});

async function fetchAccountEmail(provider: OAuthProviderId, accessToken: string): Promise<string | null> {
  try {
    if (provider === "google") {
      const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const info = await res.json();
      return info.email ?? null;
    }
    if (provider === "microsoft") {
      const res = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const info = await res.json();
      return info.mail ?? info.userPrincipalName ?? null;
    }
  } catch (err) {
    console.error("fetchAccountEmail failed", err);
  }
  return null;
}

function redirectWithStatus(siteUrl: string, status: "success" | "error", detail: string): Response {
  const target = new URL(`${siteUrl}/dashboard.html`);
  target.searchParams.set("calendar_connected", status === "success" ? "1" : "0");
  target.searchParams.set("calendar_detail", detail);
  return Response.redirect(target.toString(), 302);
}
