import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDomain,
  deviceType,
  formatTime,
  formatMessage,
  webhookPayload,
  createRateLimiter,
  createHandler,
  MAX_BODY_BYTES,
} from "../lib/lookup.js";

const DISCORD = "https://discord.com/api/webhooks/123/abc";
const SLACK = "https://hooks.slack.com/services/T0/B0/xyz";
const FIXED = new Date("2026-11-22T19:14:00Z"); // 2:14 PM ET
const quiet = { log() {}, error() {} };

function req(body, { ua = "Mozilla/5.0 (iPhone)", raw } = {}) {
  return new Request("https://example.com/api/lookup", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": ua },
    body: raw ?? JSON.stringify(body),
  });
}

function fakeFetch(status = 204) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(null, { status });
  };
  fn.calls = calls;
  return fn;
}

function handler(opts = {}) {
  return createHandler({
    getWebhook: () => DISCORD,
    now: () => FIXED,
    log: quiet,
    ...opts,
  });
}

// normalizeDomain

test("normalizeDomain accepts plain domains and subdomains", () => {
  assert.equal(normalizeDomain("acme.io"), "acme.io");
  assert.equal(normalizeDomain("app.acme.co.uk"), "app.acme.co.uk");
  assert.equal(normalizeDomain("my-company.com"), "my-company.com");
});

test("normalizeDomain cleans up what people actually type", () => {
  assert.equal(normalizeDomain("  ACME.io "), "acme.io");
  assert.equal(normalizeDomain("https://www.Acme.io/pricing?x=1#top"), "acme.io");
  assert.equal(normalizeDomain("http://acme.io:8080"), "acme.io");
  assert.equal(normalizeDomain("acme.io."), "acme.io");
});

test("normalizeDomain rejects anything that isn't a domain", () => {
  for (const bad of [
    "",
    "localhost",
    "acme",
    "<script>alert(1)</script>",
    "@everyone.com x",
    "acme..io",
    ".acme.io",
    "-acme.io",
    "a".repeat(121) + ".io",
    "acme io",
    null,
    42,
    {},
  ]) {
    assert.equal(normalizeDomain(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// small helpers

test("deviceType only distinguishes phone from desktop", () => {
  assert.equal(deviceType("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"), "phone");
  assert.equal(deviceType("Mozilla/5.0 (Linux; Android 15) Mobile"), "phone");
  assert.equal(deviceType("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)"), "desktop");
  assert.equal(deviceType(), "desktop");
});

test("formatTime uses the configured time zone", () => {
  assert.equal(formatTime(FIXED), "2:14 PM ET");
  assert.equal(formatTime(FIXED, "Europe/London", "UK"), "7:14 PM UK");
});

test("formatMessage covers matched and unmatched lookups", () => {
  const base = { domain: "acme.io", device: "phone", time: "2:14 PM ET" };
  assert.equal(formatMessage({ ...base, matched: true }), "✅ Case file opened: acme.io · phone · 2:14 PM ET");
  assert.equal(
    formatMessage({ ...base, matched: false }),
    "🆕 No case file yet: acme.io · phone · 2:14 PM ET. Build one?"
  );
});

test("webhookPayload disables Discord mentions and speaks Slack's format", () => {
  assert.deepEqual(webhookPayload(DISCORD, "hi"), { content: "hi", allowed_mentions: { parse: [] } });
  assert.deepEqual(webhookPayload(SLACK, "hi"), { text: "hi" });
});

test("rate limiter allows the limit, blocks the next, and recovers", () => {
  const limited = createRateLimiter({ limit: 3, windowMs: 1000 });
  assert.equal(limited(0), false);
  assert.equal(limited(10), false);
  assert.equal(limited(20), false);
  assert.equal(limited(30), true);
  assert.equal(limited(1015), false); // first hit has aged out
});

// handler

test("valid lookup posts one alert and returns 204", async () => {
  const f = fakeFetch();
  const res = await handler({ fetchImpl: f })(req({ domain: "https://www.Venn.city/", matched: true }));
  assert.equal(res.status, 204);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, DISCORD);
  assert.equal(f.calls[0].body.content, "✅ Case file opened: venn.city · phone · 2:14 PM ET");
  assert.deepEqual(f.calls[0].body.allowed_mentions, { parse: [] });
});

test("only the four allowed facts reach the webhook", async () => {
  const f = fakeFetch();
  await handler({ fetchImpl: f })(
    req({ domain: "acme.io", matched: false, email: "someone@acme.io", ip: "1.2.3.4" })
  );
  const sent = JSON.stringify(f.calls[0].body);
  assert.ok(!sent.includes("someone@acme.io"));
  assert.ok(!sent.includes("1.2.3.4"));
  assert.ok(!sent.includes("iPhone")); // raw user agent is never forwarded
});

test("bad input is rejected with 400 and nothing is posted", async () => {
  const f = fakeFetch();
  const h = handler({ fetchImpl: f });
  for (const r of [
    req(null, { raw: "not json" }),
    req({ domain: "acme.io" }), // matched missing
    req({ domain: "acme.io", matched: "yes" }),
    req({ domain: "<b>hi</b>", matched: false }),
    req({ matched: true }),
  ]) {
    assert.equal((await h(r)).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test("oversized bodies are rejected with 413", async () => {
  const f = fakeFetch();
  const pad = "x".repeat(MAX_BODY_BYTES);
  const res = await handler({ fetchImpl: f })(req({ domain: "acme.io", matched: false, pad }));
  assert.equal(res.status, 413);
  assert.equal(f.calls.length, 0);
});

test("rate-limited lookups get 429 and nothing is posted", async () => {
  const f = fakeFetch();
  const h = handler({ fetchImpl: f, limiter: createRateLimiter({ limit: 1 }) });
  assert.equal((await h(req({ domain: "a.io", matched: false }))).status, 204);
  assert.equal((await h(req({ domain: "b.io", matched: false }))).status, 429);
  assert.equal(f.calls.length, 1);
});

test("with no webhook configured, lookups are accepted quietly", async () => {
  const f = fakeFetch();
  const res = await handler({ fetchImpl: f, getWebhook: () => undefined })(req({ domain: "acme.io", matched: true }));
  assert.equal(res.status, 204);
  assert.equal(f.calls.length, 0);
});

test("a failing or slow webhook never breaks the visitor's request", async () => {
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  const boom = async () => {
    throw Object.assign(new Error("x"), { name: "TimeoutError" });
  };
  const res = await handler({ fetchImpl: boom, log })(req({ domain: "acme.io", matched: true }));
  assert.equal(res.status, 204);
  assert.deepEqual(lines, ["lookup: webhook timeout"]);
});

test("logs carry the status code only, never the webhook URL", async () => {
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  await handler({ fetchImpl: fakeFetch(500), log })(req({ domain: "acme.io", matched: true }));
  assert.deepEqual(lines, ["lookup: webhook 500"]);
  assert.ok(!lines.join(" ").includes("discord.com"));
});

test("Slack webhooks get Slack's message format", async () => {
  const f = fakeFetch(200);
  await handler({ fetchImpl: f, getWebhook: () => SLACK })(
    req({ domain: "acme.io", matched: false }, { ua: "Mozilla/5.0 (Macintosh)" })
  );
  assert.deepEqual(f.calls[0].body, { text: "🆕 No case file yet: acme.io · desktop · 2:14 PM ET. Build one?" });
});
