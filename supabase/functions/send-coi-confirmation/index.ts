// Sends a one-time email when someone's recipient status changes for a COI
// notification phase -- "added" (see the trigger in
// sql/supabase-coi-notifications-confirmation-trigger-setup.sql) or
// "removed" (same trigger, same file). Not called directly by the client --
// the trigger calls this. Shares the RESEND_API_KEY / RESEND_FROM_EMAIL
// secrets already set for send-coi-reminders -- Supabase function secrets
// are project-wide, not per-function, so nothing extra needs to be
// configured for this one.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "COI Alerts <onboarding@resend.dev>";

const PHASE_LABEL: Record<string, string> = {
  "60_day": "60 Days Before Expiration",
  "30_day": "30 Days Before Expiration",
  "7_day_daily": "Expiring Within 7 Days (sent daily)",
  "expired_daily": "COI Expired (sent daily)",
};

Deno.serve(async (req: Request) => {
  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set.");
    return new Response(JSON.stringify({ ok: false, error: "RESEND_API_KEY not configured" }), { status: 500 });
  }

  let email: string, phase: string, action: string;
  try {
    const body = await req.json();
    email = String(body.email || "").trim();
    phase = String(body.phase || "").trim();
    action = String(body.action || "added").trim().toLowerCase();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), { status: 400 });
  }

  if (!email || !phase) {
    return new Response(JSON.stringify({ ok: false, error: "email and phase are required" }), { status: 400 });
  }
  if (action !== "added" && action !== "removed") {
    return new Response(JSON.stringify({ ok: false, error: "action must be 'added' or 'removed'" }), { status: 400 });
  }

  const phaseLabel = PHASE_LABEL[phase] || phase;

  const subject = action === "removed"
    ? `You've been removed from COI reminders: ${phaseLabel}`
    : `You're now subscribed to COI reminders: ${phaseLabel}`;

  const text = action === "removed"
    ? [
        `You've been removed from automatic vendor Certificate of Insurance (COI) email reminders.`,
        ``,
        `Phase: ${phaseLabel}`,
        ``,
        `You will no longer get emails for this window. No action needed -- this is just confirming the change.`,
        ``,
        `If this wasn't intentional, ask IT or a Super Admin to add you back on the Vendors page -> More Actions -> COI Notifications.`,
        ``,
        `This is an automated message from the LeeWard Group staff portal.`,
      ].join("\n")
    : [
        `You've been added to receive automatic vendor Certificate of Insurance (COI) email reminders.`,
        ``,
        `Phase: ${phaseLabel}`,
        ``,
        `You'll get an email whenever a vendor's COI falls into this window -- no action needed right now, this is just confirming you're on the list.`,
        ``,
        `If this doesn't sound right, ask IT or a Super Admin to remove you from the Vendors page -> More Actions -> COI Notifications.`,
        ``,
        `This is an automated message from the LeeWard Group staff portal.`,
      ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`Failed to send ${action} notice to ${email}:`, res.status, errText);
      return new Response(JSON.stringify({ ok: false, error: errText }), { status: 502 });
    }
  } catch (err) {
    console.error(`Failed to send ${action} notice to ${email}:`, err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
