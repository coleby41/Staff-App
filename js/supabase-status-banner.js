/* ============================================================================
   SUPABASE STATUS BANNER (login pages only)

   Coleby: "add a banner to all of the login page that when there is an
   outage with supabase it will display... it looks like our server
   provider is having some issues..." — shown only while Supabase itself is
   reporting a real incident, hidden the rest of the time.

   Checks https://status.supabase.com/api/v2/status.json once on page load —
   a standard Statuspage.io-format endpoint (the same product many other
   companies' public status pages run on), publicly readable with no API key
   and no Supabase project credentials involved. Its `status.indicator` field
   is one of:
     "none"     — all systems operational (banner stays hidden)
     "minor"    — minor service degradation
     "major"    — significant outage affecting multiple components
     "critical" — severe, system-wide failure
   Anything other than "none" shows the banner.

   Fails CLOSED on purpose: if the request errors, times out, or the response
   doesn't parse the way expected, the banner just stays hidden rather than
   showing a possibly-wrong "we're having issues" message on top of the
   login form. A broken status check should never be able to alarm everyone
   trying to sign in.

   Include this on any page that has the #supabaseStatusBanner markup (see
   pages/login.html / index.html) — it's a no-op on any page that doesn't.
============================================================================ */

(function () {
  var STATUS_URL = "https://status.supabase.com/api/v2/status.json";
  var FETCH_TIMEOUT_MS = 6000;

  function showBanner() {
    var el = document.getElementById("supabaseStatusBanner");
    if (el) el.classList.remove("hidden");
  }

  function checkSupabaseStatus() {
    var banner = document.getElementById("supabaseStatusBanner");
    if (!banner) return; // this page doesn't have the banner markup

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timeoutId = controller
      ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS)
      : null;

    fetch(STATUS_URL, controller ? { signal: controller.signal } : {})
      .then(function (res) {
        if (!res.ok) throw new Error("Supabase status check returned " + res.status);
        return res.json();
      })
      .then(function (data) {
        var indicator = data && data.status && data.status.indicator;
        if (indicator && indicator !== "none") showBanner();
      })
      .catch(function (error) {
        console.warn("supabase-status-banner: couldn't check Supabase status, leaving banner hidden.", error);
      })
      .finally(function () {
        if (timeoutId) clearTimeout(timeoutId);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkSupabaseStatus);
  } else {
    checkSupabaseStatus();
  }
})();
