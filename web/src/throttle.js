// Shared transient-rate-limit throttle window.
//
// Both the user-facing turn runner (providers/claude.js) and the background
// fan-out (cheap-model.js: decision-extractor / observer / contract-check) read
// and write this single window. Effect: a 429 *anywhere* briefly slows
// *everything*, and the cheap background calls don't pile on while a user turn
// is mid-retry — which is what was tripping the server-side throttle in the
// first place.
//
// A "transient" throttle ("temporarily limiting requests", overloaded, HTTP
// 429) is deliberately distinct from the account usage cap ("usage limit
// reached / will reset"), which is NOT something to retry into.
let _until = 0;

function isTransientRateLimit(text) {
  if (!text || typeof text !== "string") return false;
  if (/usage limit/i.test(text) && /(reach|reset)/i.test(text)) return false; // account cap, not transient
  return /temporarily limiting requests/i.test(text)
      || /\boverloaded\b/i.test(text)
      || /rate.?limit/i.test(text)
      || /(^|\D)429(\D|$)/.test(text);
}

function throttleUntil() { return _until; }
function remaining() { return Math.max(0, _until - Date.now()); }

// Extend the window so it ends at least `ms` from now.
function bump(ms) { _until = Math.max(_until, Date.now() + ms); return _until; }

// Resolve once the current window clears. Capped so a runaway window can never
// hang a background call forever.
function waitForThrottle(capMs = 60000) {
  const wait = Math.min(capMs, remaining());
  return wait > 0 ? new Promise(r => setTimeout(r, wait)) : Promise.resolve();
}

module.exports = { isTransientRateLimit, throttleUntil, remaining, bump, waitForThrottle };
