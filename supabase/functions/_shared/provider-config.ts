// Shared OAuth provider config for the calendar Edge Functions.
// Reads client id/secret/redirect URI from environment secrets you set with:
//   supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REDIRECT_URI=...
//   supabase secrets set MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... MICROSOFT_REDIRECT_URI=...
//   supabase secrets set SITE_URL=https://your-portal-domain.example
//
// GOOGLE_REDIRECT_URI / MICROSOFT_REDIRECT_URI must exactly match the
// deployed URL of calendar-oauth-callback, and must be registered as an
// "Authorized redirect URI" in the Google Cloud Console / Azure App
// Registration for these credentials to work.

export type OAuthProviderId = "google" | "microsoft";

export interface OAuthProviderConfig {
  authEndpoint: string;
  tokenEndpoint: string;
  scope: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  extraAuthParams?: Record<string, string>;
}

export function getOAuthProviderConfig(provider: OAuthProviderId): OAuthProviderConfig {
  if (provider === "google") {
    return {
      authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/calendar.readonly",
      clientId: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      clientSecret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      redirectUri: Deno.env.get("GOOGLE_REDIRECT_URI") ?? "",
      extraAuthParams: { access_type: "offline", prompt: "consent" },
    };
  }

  if (provider === "microsoft") {
    return {
      authEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scope: "offline_access Calendars.Read",
      clientId: Deno.env.get("MICROSOFT_CLIENT_ID") ?? "",
      clientSecret: Deno.env.get("MICROSOFT_CLIENT_SECRET") ?? "",
      redirectUri: Deno.env.get("MICROSOFT_REDIRECT_URI") ?? "",
    };
  }

  throw new Error(`Unsupported OAuth provider: ${provider}`);
}

export function getSiteUrl(): string {
  return Deno.env.get("SITE_URL") ?? "";
}

export function encodeState(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload));
}

export function decodeState(state: string): Record<string, unknown> {
  return JSON.parse(atob(state));
}
