# lookup-alerts

```
( ( • ) )
    |
.---+---.     ping: a company just looked itself up.
| ^   ^ |     pong: you know about it in seconds.
|  \_/  |
'-------'
 \|   |/
```

Get a Discord or Slack alert the moment a company looks itself up on your site.

I built this for my own portfolio, [thewillmauro.com](https://thewillmauro.com). Visitors type their company's website into a terminal, and if I've built a project for that company, it opens. Either way I get a message like this:

```
✅ Case file opened: venn.city · phone · 2:14 PM ET
🆕 No case file yet: acme.io · desktop · 2:14 PM ET. Build one?
```

A company looking itself up is a buying signal. This turns it into an alert the right person sees in seconds, without collecting anything personal about the visitor.

## How it works

```
browser                         /api/lookup (Vercel function)                Discord or Slack
sendLookup("acme.io", false) ─▶ validate → rate limit → format message ─▶ one-line alert
   (sendBeacon, never blocks)     returns 204 right after                      (mentions off)
```

- **`lib/lookup.js`** holds all the logic as small pure functions plus `createHandler()`, which takes its clock, `fetch` and webhook as arguments so every path is testable.
- **`api/lookup.js`** is the Vercel serverless function, a few lines that wire the handler up.
- **`client/lookup-client.js`** sends the lookup with `navigator.sendBeacon`, falling back to `fetch` with `keepalive`. It never throws, so a failed alert can't break the page.
- **`index.html`** is a working demo.

## Private by design

| What | Rule |
| --- | --- |
| Data sent on | The domain typed, whether it matched, phone or desktop, and the time. Nothing else. |
| Never read or stored | IP addresses, emails, the raw user agent, cookies, or any extra fields in the request. |
| Input | Normalized (`https://www.Acme.io/pricing` → `acme.io`), then letters, numbers, dots and hyphens only, up to 120 characters. Anything else gets `400`. |
| Size | Request bodies over 1 KB get `413`. |
| Abuse | 20 lookups a minute per instance, then `429`. Discord mentions are disabled, so typed text can never ping `@everyone`. |
| Secrets | The webhook URL lives only in an environment variable. Logs record the webhook's status code, never its URL or the request. |
| Failure | A slow or broken webhook is cut off after 3 seconds and logged. The visitor's request still succeeds. |

## Use it

1. Create an incoming webhook in Discord (channel settings → Integrations → Webhooks) or Slack (Incoming Webhooks app).
2. Deploy this repo to Vercel, or copy `lib/` and `api/` into your own project.
3. In Vercel project settings, add the environment variable `LOOKUP_WEBHOOK_URL` with your webhook URL. Don't commit it.
4. Optional: set `LOOKUP_TIME_ZONE` (an IANA name such as `Europe/London`) and `LOOKUP_TIME_LABEL` (such as `UK`). The default is New York time, labeled `ET`.
5. On your page:

```html
<script type="module">
  import { sendLookup } from "/client/lookup-client.js";
  sendLookup("acme.io", false); // domain typed, and whether you had a match
</script>
```

Until `LOOKUP_WEBHOOK_URL` is set, lookups are accepted with `204` and nothing is posted, so you can ship the page first.

## Tests

```
npm test
```

17 tests on Node's built-in test runner, with no dependencies to install. They cover domain cleanup and rejection, the exact message format for Discord and Slack, that extra fields like emails and IPs never reach the webhook, size and rate limits, the no-webhook case, slow and failing webhooks, and that logs never contain the webhook URL. CI runs them on Node 20 and 22 for every push.

## What broke while building it

- **Alerts never arrived.** The first version returned its response before the webhook call finished, and the serverless runtime dropped the call. Now the function waits for the post, capped at 3 seconds, before answering.
- **Cleanup lived only in the browser.** My site turned `https://www.Venn.city/` into `venn.city` before sending, but anyone calling the endpoint directly could skip that. For this repo the function normalizes input itself, so it's safe no matter what calls it.

## License

MIT
