// Vercel serverless function: POST /api/lookup
// Body: {"domain": "acme.io", "matched": false}
// Set LOOKUP_WEBHOOK_URL (Discord or Slack incoming webhook) in your
// Vercel project settings. Until it's set, lookups return 204 and nothing posts.
import { createHandler } from "../lib/lookup.js";

export const POST = createHandler();

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
