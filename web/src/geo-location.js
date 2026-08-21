// geo-location: auto-detect the operator's location from the WS client IP and
// push it to orchestratorHero's context store (POST /api/context/location),
// where loadLocationContextBlock (providers/context.js) reads it back into the
// "# whereAndWhen" banner on every chat system prompt.
//
// Scope: this is a UX signal for time-of-day / timezone reasoning only — NOT a
// system of record for anything consequential (Schengen day-counting stays
// driven by verified entry/exit dates via the deadlines endpoints). It never
// silently overrides a manually-set location: any POST that replaces a record
// whose source isn't "ip-geolocation" is logged loudly with what it replaced.
//
// Philosophy mirrors loadLocationContextBlock: fully async, short timeouts,
// silent fallback — never blocks WS connection setup or message handling.
//
// Client-IP header trust: the app sits behind Cloudflare Tunnel → cloudflared →
// nginx → :7683. The nginx /terminal/ws block sets X-Real-IP=$remote_addr
// (which is 127.0.0.1, useless) but does NOT override X-Forwarded-For or
// CF-Connecting-IP, so Cloudflare's edge headers pass through. Every connect
// logs which headers were actually present so the fallback order below stays
// empirically verifiable: CF-Connecting-IP > first X-Forwarded-For hop > X-Real-IP.

const CONTEXT_NOW_URL = "http://127.0.0.1:8000/api/context/now";
const CONTEXT_LOCATION_URL = "http://127.0.0.1:8000/api/context/location";
// ip-api.com free tier: no key, ~45 req/min — far above our rate since the
// per-IP debounce below means we look up each distinct client IP at most once
// per few hours, not per reconnect/ping.
const GEOIP_URL = "http://ip-api.com/json/";
const GEOIP_FIELDS = "status,message,country,countryCode,city,regionName,timezone,query";
const IP_DEBOUNCE_MS = 4 * 60 * 60 * 1000; // 4h per-IP — absorbs mobile-network geolocation bounce
const IP_CACHE_MAX = 500;

const _ipCheckedAt = new Map(); // ip -> ts of last lookup attempt (success or fail)

function _isPublicIp(ip) {
  if (!ip) return false;
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true;
  }
  return ip.includes(":"); // other IPv6 — treat as public
}

function _pickClientIp(headers) {
  const cf = String(headers["cf-connecting-ip"] || "").trim();
  const xffRaw = String(headers["x-forwarded-for"] || "").trim();
  const xff = xffRaw ? xffRaw.split(",")[0].trim() : "";
  const xri = String(headers["x-real-ip"] || "").trim();
  let ip = "", header = "";
  if (_isPublicIp(cf)) { ip = cf; header = "cf-connecting-ip"; }
  else if (_isPublicIp(xff)) { ip = xff; header = "x-forwarded-for"; }
  else if (_isPublicIp(xri)) { ip = xri; header = "x-real-ip"; }
  return { ip, header, cf, xffRaw, xri };
}

async function _fetchJson(url, opts, timeoutMs) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function _detectAndMaybePost(ip, header) {
  const geo = await _fetchJson(GEOIP_URL + encodeURIComponent(ip) + "?fields=" + GEOIP_FIELDS, {}, 4000);
  if (geo.status !== "success" || !geo.country || !geo.timezone) {
    console.warn("[geo-ip] lookup failed for", ip, "-", geo.message || "no country/timezone");
    return;
  }

  let stored = null;
  try {
    const now = await _fetchJson(CONTEXT_NOW_URL, {}, 2000);
    stored = now && now.location ? now.location : null;
  } catch (e) {
    console.warn("[geo-ip] could not read stored location (" + e.message + ") — skipping update to avoid blind override");
    return;
  }

  // Meaningful-change gate: country must differ. City-level bounce within the
  // same country (mobile carriers geolocate erratically) never fires a POST.
  const storedCountry = String((stored && stored.country) || "").trim().toLowerCase();
  const geoCountry = String(geo.country).trim().toLowerCase();
  if (storedCountry && storedCountry === geoCountry) return;

  const place = [geo.city, geo.regionName].filter(Boolean).join(", ") || geo.country;
  const prevDesc = stored ? `${stored.place || "?"} (source=${stored.source || "?"})` : "none";
  const body = {
    place,
    timezone: geo.timezone,
    country: geo.country,
    source: "ip-geolocation",
    note: `Auto-detected from WS connect, ${header}=${ip}; replaced: ${prevDesc}`,
  };
  // Visible-override guarantee: a manually/verified-set location being replaced
  // by IP inference must be loud in the journal, not silent.
  if (stored && stored.source && stored.source !== "ip-geolocation") {
    console.warn(`[geo-ip] OVERRIDING ${stored.source} location "${stored.place}" -> "${place}" (${geo.country}) from ${ip}`);
  }
  await _fetchJson(CONTEXT_LOCATION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 3000);
  console.log(`[geo-ip] location updated: ${place}, ${geo.country} (${geo.timezone}) via ${header}=${ip}, was: ${prevDesc}`);
}

// Called synchronously from the WS connection handler — must stay cheap.
// Header parse + cache check only; all network I/O is fired async.
function noteClientConnection(req) {
  const headers = (req && req.headers) || {};
  const { ip, header, cf, xffRaw, xri } = _pickClientIp(headers);
  console.log(
    `[geo-ip] ws connect headers: cf-connecting-ip=${cf || "-"} x-forwarded-for=${xffRaw || "-"} x-real-ip=${xri || "-"}` +
    (ip ? ` -> using ${header}=${ip}` : " -> no public client IP")
  );
  if (!ip) return;

  const last = _ipCheckedAt.get(ip);
  if (last && Date.now() - last < IP_DEBOUNCE_MS) return;
  _ipCheckedAt.set(ip, Date.now()); // mark before the async work so concurrent connects don't double-fire
  if (_ipCheckedAt.size > IP_CACHE_MAX) {
    const oldest = _ipCheckedAt.keys().next().value;
    _ipCheckedAt.delete(oldest);
  }

  _detectAndMaybePost(ip, header).catch(e => {
    console.warn("[geo-ip] detect failed for", ip, "-", e.message);
  });
}

module.exports = { noteClientConnection, _pickClientIp, _isPublicIp };
