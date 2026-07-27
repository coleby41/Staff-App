/* ============================================================================
   weather-card.js — "Weather" dashboard card (OpenWeatherMap)
   Requires this markup in dashboard.html:

     <div class="card">
       <div class="card-header">
         <div>
           <h2 class="card-title">☀️ Weather</h2>
           <p class="card-subtitle" id="weatherLocation">Wilmington, NC</p>
         </div>
       </div>
       <div id="weatherBody"></div>
       <a href="#" id="viewFullForecastLink" class="auth-link" target="_blank" rel="noopener">View full forecast</a>
     </div>

   ⚠️ CONFIG REQUIRED: set WEATHER_CONFIG.apiKey below to your OpenWeatherMap
   API key (https://openweathermap.org/api). The free tier covers both
   endpoints used here (Current Weather + 5 day / 3 hour Forecast).

   Note: this calls the OpenWeatherMap API directly from the browser, which
   means the API key is visible in the page source. That's the normal/
   accepted pattern for OWM's free tier (rate-limited per key, not billing-
   sensitive) — the same tradeoff most sites make. If you'd rather hide the
   key entirely, this call could be proxied through a Supabase Edge Function
   the same way the calendar OAuth flow is — say the word and I'll move it.
============================================================================ */

(function () {
  "use strict";

  const WEATHER_CONFIG = {
    apiKey: "c35767831b8149c5a48d9aa5eefc06a9", // <-- fill in
    city: "Wilmington",
    state: "NC",
    country: "US",
    units: "imperial",
  };

  const GEOCODE_CACHE_KEY = "weatherGeocodeCache";

  document.addEventListener("DOMContentLoaded", async () => {
    const bodyEl = document.getElementById("weatherBody");
    if (!bodyEl) return;

    if (!WEATHER_CONFIG.apiKey || WEATHER_CONFIG.apiKey === "YOUR_OPENWEATHERMAP_API_KEY") {
      bodyEl.innerHTML = `<p class="card-subtitle">Weather isn't configured yet (missing OpenWeatherMap API key in weather-card.js).</p>`;
      return;
    }

    try {
      const { lat, lon } = await getCoordinates();
      const [current, forecast] = await Promise.all([
        fetchCurrentWeather(lat, lon),
        fetchTodayForecast(lat, lon),
      ]);
      renderWeather(current, forecast);
      wireForecastLink(lat, lon);
    } catch (err) {
      console.error("weather-card: failed to load weather", err);
      bodyEl.innerHTML = `<p class="card-subtitle">Weather is unavailable right now.</p>`;
    }
  });

  async function getCoordinates() {
    try {
      const cached = JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || "null");
      if (cached && cached.city === WEATHER_CONFIG.city) return cached;
    } catch (_) {
      /* ignore bad cache */
    }

    const q = `${WEATHER_CONFIG.city},${WEATHER_CONFIG.state},${WEATHER_CONFIG.country}`;
    const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(q)}&limit=1&appid=${WEATHER_CONFIG.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Geocoding request failed");
    const results = await res.json();
    if (!results.length) throw new Error("No geocoding match for configured city");

    const coords = { city: WEATHER_CONFIG.city, lat: results[0].lat, lon: results[0].lon };
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(coords));
    return coords;
  }

  async function fetchCurrentWeather(lat, lon) {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=${WEATHER_CONFIG.units}&appid=${WEATHER_CONFIG.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Current weather request failed");
    return res.json();
  }

  async function fetchTodayForecast(lat, lon) {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=${WEATHER_CONFIG.units}&appid=${WEATHER_CONFIG.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Forecast request failed");
    const data = await res.json();

    const todayStr = new Date().toISOString().slice(0, 10);
    const todaysEntries = (data.list || []).filter((e) => e.dt_txt.startsWith(todayStr));
    const entries = todaysEntries.length ? todaysEntries : (data.list || []).slice(0, 8);

    const highs = entries.map((e) => e.main.temp_max);
    const lows = entries.map((e) => e.main.temp_min);
    const pops = entries.map((e) => e.pop || 0);

    return {
      high: highs.length ? Math.round(Math.max(...highs)) : null,
      low: lows.length ? Math.round(Math.min(...lows)) : null,
      rainChance: pops.length ? Math.round(Math.max(...pops) * 100) : 0,
    };
  }

  function renderWeather(current, forecast) {
    const bodyEl = document.getElementById("weatherBody");
    const iconCode = current.weather?.[0]?.icon || "01d";
    const description = current.weather?.[0]?.main || "—";

    bodyEl.innerHTML = `
      <div class="weather-main">
        <div class="weather-temp">${Math.round(current.main.temp)}°F</div>
        <img class="weather-icon" src="https://openweathermap.org/img/wn/${iconCode}@2x.png" alt="${DS_escapeHtml(description)}" width="64" height="64" />
      </div>
      <p class="weather-desc">${DS_escapeHtml(description)}</p>
      <p class="weather-highlow">H: ${forecast.high ?? "—"}°  L: ${forecast.low ?? "—"}°</p>
      <div class="weather-stats">
        <div class="weather-stat"><span class="weather-stat-value">${forecast.rainChance}%</span><span class="weather-stat-label">Rain</span></div>
        <div class="weather-stat"><span class="weather-stat-value">${Math.round(current.wind?.speed || 0)} mph</span><span class="weather-stat-label">Wind</span></div>
        <div class="weather-stat"><span class="weather-stat-value">${current.main.humidity}%</span><span class="weather-stat-label">Humidity</span></div>
      </div>
    `;
  }

  function wireForecastLink(lat, lon) {
    const link = document.getElementById("viewFullForecastLink");
    if (!link) return;
    // OpenWeatherMap's public weather map, centered + zoomed on the same
    // coordinates used for the card above, so it shows the same location.
    link.href = `https://openweathermap.org/weathermap?zoom=11&lat=${lat}&lon=${lon}&layer=temperature`;
  }

  function DS_escapeHtml(str) {
    if (window.DashboardShared) return window.DashboardShared.escapeHtml(str);
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }
})();