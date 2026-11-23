// Drop-in browser helper. Sends a lookup in the background so the visitor
// never waits on it, and never throws.
export function sendLookup(domain, matched, endpoint = "/api/lookup") {
  try {
    const body = JSON.stringify({ domain: String(domain).slice(0, 200), matched: !!matched });
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon(endpoint, blob)) return;
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* alerts are best-effort; the page keeps working */
  }
}
