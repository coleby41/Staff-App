/* ============================================================================
   weather-card.js — "Weather" dashboard card (Open-Meteo)
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

   No API key required — Open-Meteo's forecast + geocoding endpoints are free
   and keyless, so nothing to configure and nothing exposed in the page
   source. Replaces the previous OpenWeatherMap free-tier integration, which
   only returned a same-day high/low (no real 7-day data) and whose "View
   full forecast" link pointed at OWM's public weather *map* rather than an
   actual forecast page.

   "View full forecast" now links to the National Weather Service's
   forecast page for the resolved coordinates (a real multi-day forecast,
   not a map).
============================================================================ */

(function () {
  "use strict";

  const WEATHER_CONFIG = {
    city: "Wilmington",
    state: "North Carolina",
    country: "US",
  };

  const GEOCODE_CACHE_KEY = "weatherGeocodeCacheV2";

  // WMO weather codes -> { icon, label } used by Open-Meteo's `weather_code` fields.
  // https://open-meteo.com/en/docs (see "WMO Weather interpretation codes")
  const WMO_CODES = {
    0: { icon: "☀️", label: "Clear sky" },
    1: { icon: "🌤️", label: "Mainly clear" },
    2: { icon: "⛅", label: "Partly cloudy" },
    3: { icon: "☁️", label: "Overcast" },
    45: { icon: "🌫️", label: "Fog" },
    48: { icon: "🌫️", label: "Rime fog" },
    51: { icon: "🌦️", label: "Light drizzle" },
    53: { icon: "🌦️", label: "Drizzle" },
    55: { icon: "🌧️", label: "Dense drizzle" },
    56: { icon: "🌧️", label: "Freezing drizzle" },
    57: { icon: "🌧️", label: "Freezing drizzle" },
    61: { icon: "🌦️", label: "Light rain" },
    63: { icon: "🌧️", label: "Rain" },
    65: { icon: "🌧️", label: "Heavy rain" },
    66: { icon: "🌧️", label: "Freezing rain" },
    67: { icon: "🌧️", label: "Freezing rain" },
    71: { icon: "🌨️", label: "Light snow" },
    73: { icon: "🌨️", label: "Snow" },
    75: { icon: "❄️", label: "Heavy snow" },
    77: { icon: "❄️", label: "Snow grains" },
    80: { icon: "🌦️", label: "Rain showers" },
    81: { icon: "🌧️", label: "Rain showers" },
    82: { icon: "⛈️", label: "Violent showers" },
    85: { icon: "🌨️", label: "Snow showers" },
    86: { icon: "❄️", label: "Snow showers" },
    95: { icon: "⛈️", label: "Thunderstorm" },
    96: { icon: "⛈️", label: "Thunderstorm w/ hail" },
    99: { icon: "⛈️", label: "Thunderstorm w/ hail" },
  };

  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  document.addEventListener("DOMContentLoaded", async () => {
    const bodyEl = document.getElementById("weatherBody");
    if (!bodyEl) return;

    try {
      const { lat, lon } = await getCoordinates();
      const data = await fetchWeather(lat, lon);
      renderWeather(data);
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

    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      WEATHER_CONFIG.city
    )}&count=10&language=en&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Geocoding request failed");
    const data = await res.json();
    const results = data.results || [];
    if (!results.length) throw new Error("No geocoding match for configured city");

    const match =
      results.find(
        (r) => r.country_code === WEATHER_CONFIG.country && r.admin1 === WEATHER_CONFIG.state
      ) || results[0];

    const coords = { city: WEATHER_CONFIG.city, lat: match.latitude, lon: match.longitude };
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(coords));
    return coords;
  }

  async function fetchWeather(lat, lon) {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Forecast request failed");
    return res.json();
  }

  function renderWeather(data) {
    const bodyEl = document.getElementById("weatherBody");
    const current = data.current || {};
    const daily = data.daily || {};

    const currentCode = WMO_CODES[current.weather_code] || { icon: "🌡️", label: "—" };
    const todayHigh = daily.temperature_2m_max?.[0];
    const todayLow = daily.temperature_2m_min?.[0];
    const todayRain = daily.precipitation_probability_max?.[0];

    bodyEl.innerHTML = `
      <div class="weather-main">
        <div class="weather-temp">${Math.round(current.temperature_2m)}°F</div>
        <div class="weather-icon" role="img" aria-label="${DS_escapeHtml(currentCode.label)}">${currentCode.icon}</div>
      </div>
      <p class="weather-desc">${DS_escapeHtml(currentCode.label)}</p>
      <p class="weather-highlow">H: ${todayHigh != null ? Math.round(todayHigh) : "—"}°  L: ${todayLow != null ? Math.round(todayLow) : "—"}°</p>
      <div class="weather-stats">
        <div class="weather-stat"><span class="weather-stat-value">${todayRain != null ? Math.round(todayRain) : 0}%</span><span class="weather-stat-label">Rain</span></div>
        <div class="weather-stat"><span class="weather-stat-value">${Math.round(current.wind_speed_10m || 0)} mph</span><span class="weather-stat-label">Wind</span></div>
        <div class="weather-stat"><span class="weather-stat-value">${Math.round(current.relative_humidity_2m || 0)}%</span><span class="weather-stat-label">Humidity</span></div>
      </div>
      <div class="weather-week">
        ${renderWeekRow(daily)}
      </div>
    `;
  }

  function renderWeekRow(daily) {
    const times = daily.time || [];
    return times
      .map((dateStr, i) => {
        const code = WMO_CODES[daily.weather_code?.[i]] || { icon: "🌡️", label: "—" };
        const high = daily.temperature_2m_max?.[i];
        const low = daily.temperature_2m_min?.[i];
        // Parse as local date (avoid UTC-shift-by-one from `new Date(dateStr)`).
        const [y, m, d] = dateStr.split("-").map(Number);
        const dayName = i === 0 ? "Today" : DAY_LABELS[new Date(y, m - 1, d).getDay()];

        return `
          <div class="weather-day">
            <span class="weather-day-name">${DS_escapeHtml(dayName)}</span>
            <span class="weather-day-icon" role="img" aria-label="${DS_escapeHtml(code.label)}">${code.icon}</span>
            <span class="weather-day-high">${high != null ? Math.round(high) : "—"}°</span>
            <span class="weather-day-low">${low != null ? Math.round(low) : "—"}°</span>
          </div>
        `;
      })
      .join("");
  }

  function wireForecastLink(lat, lon) {
    const link = document.getElementById("viewFullForecastLink");
    if (!link) return;
    // National Weather Service forecast page for these coordinates — an
    // actual multi-day forecast, not a map.
    link.href = `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`;
  }

  function DS_escapeHtml(str) {
    if (window.DashboardShared) return window.DashboardShared.escapeHtml(str);
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }
})();
