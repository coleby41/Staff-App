/* ===========================================================
   GOOGLE PLACES CONFIG

   Powers the address autocomplete on the "Mailing address" field in the
   New Project Onboard wizard (Step 1 — Property Owner Contact Info).

   The key below is a browser-side Google Maps/Places key — these are
   meant to be public (they show up in network requests either way).
   What actually keeps it safe is restricting it in Google Cloud Console
   to: the Places API + Maps JavaScript API only, and an HTTP referrer
   restriction locked to this app's real domain. If that's not set up
   yet, do that next.
=========================== */

window.GOOGLE_PLACES_API_KEY = "AIzaSyDp-nRvgdBZpg5ejxApcV46NcoNDm1SBgM";
