// Core logic for lookup alerts. No dependencies, no I/O except the
// injected `fetch`, so every piece can be tested on its own.

export const MAX_BODY_BYTES = 1024;
export const DOMAIN_RE = /^[a-z0-9.-]{1,120}$/;

/**
 * Normalize and validate a typed domain.
 * Accepts things people actually type ("https://www.Acme.io/pricing")
 * and returns the bare host ("acme.io"), or null if it isn't a domain.
 */
export function normalizeDomain(input) {
  if (typeof input !== "string") return null;
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, ""); // scheme
  d = d.split(/[/?#]/)[0]; // path, query, fragment
  d = d.replace(/:\d+$/, ""); // port
  d = d.replace(/^www\./, "");
  d = d.replace(/\.$/, ""); // trailing dot
  if (!DOMAIN_RE.test(d)) return null;
  if (!d.includes(".")) return null;
  if (d.startsWith(".") || d.startsWith("-") || d.includes("..")) return null;
  return d;
}

/** Coarse device type from the user agent. Nothing else is read from it. */
export function deviceType(ua = "") {
  return /Mobi|Android|iPhone|iPod/i.test(ua) ? "phone" : "desktop";
}

/** "2:14 PM ET" style time in the given IANA time zone. */
export function formatTime(date, timeZone = "America/New_York", label = "ET") {
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${t} ${label}`;
}

/** The one-line alert. Only these four facts ever leave the function. */
export function formatMessage({ domain, matched, device, time }) {
  return matched
    ? `✅ Case file opened: ${domain} · ${device} · ${time}`
    : `🆕 No case file yet: ${domain} · ${device} · ${time}. Build one?`;
}

/**
 * Webhook payload for Discord or Slack. Discord mentions are disabled so
 * typed text can never ping anyone.
 */
export function webhookPayload(url, content) {
  if (/hooks\.slack\.com/.test(url)) return { text: content };
  return { content, allowed_mentions: { parse: [] } };
}

/** Sliding-window rate limiter, in memory (per serverless instance). */
export function createRateLimiter({ limit = 20, windowMs = 60_000 } = {}) {
  let hits = [];
  return function limited(now = Date.now()) {
    hits = hits.filter((t) => now - t < windowMs);
    if (hits.length >= limit) return true;
    hits.push(now);
    return false;
  };
}

const empty = (status, headers) => new Response(null, { status, headers });

/**
 * Build the POST handler. Everything it depends on is passed in, so tests
 * can supply a fake fetch, clock and environment.
 */
export function createHandler({
  getWebhook = () => process.env.LOOKUP_WEBHOOK_URL,
  fetchImpl = (...a) => fetch(...a),
  now = () => new Date(),
  limiter = createRateLimiter(),
  timeoutMs = 3000,
  timeZone = process.env.LOOKUP_TIME_ZONE || "America/New_York",
  timeLabel = process.env.LOOKUP_TIME_LABEL || "ET",
  log = console,
} = {}) {
  return async function POST(request) {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > MAX_BODY_BYTES) return empty(413);

    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return empty(413);

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return empty(400);
    }
    if (!body || typeof body.matched !== "boolean") return empty(400);

    const domain = normalizeDomain(body.domain);
    if (!domain) return empty(400);

    if (limiter(now().getTime())) return empty(429);

    const webhook = getWebhook();
    if (!webhook) return empty(204); // not configured yet: accept quietly

    const content = formatMessage({
      domain,
      matched: body.matched,
      device: deviceType(request.headers.get("user-agent") || ""),
      time: formatTime(now(), timeZone, timeLabel),
    });

    try {
      const r = await fetchImpl(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookPayload(webhook, content)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Log the status only. Never the webhook URL or the request body.
      (r.ok ? log.log : log.error)(`lookup: webhook ${r.status}`);
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      log.error(timedOut ? "lookup: webhook timeout" : "lookup: webhook error");
    }
    return empty(204);
  };
}
