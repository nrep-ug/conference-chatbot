# REC Chat API v1

New to API integrations? Start with the [developer guide](developer-integration.md)
for a first request and website, mobile, and server examples. This document
is the concise API and operations reference.

All integrations use the same public REC knowledge and answering engine: the
active edition, published historical editions, and published visitor guidance.
The API cannot read private registrations or select arbitrary tables or models.

## Register A Backend

In /admin, open **API integrations** and register each backend separately
(for example, the conference website and the mobile application's API server).
Set request limits and expiry. The default key lifetime is 90 days.
The secret is returned once. Put it in the **calling backend's** secret manager
as REC_CHAT_API_KEY, not in this chatbot's public environment variables.

Keys are SHA-256 hashes at rest, with 256 random secret bits. Owners and administrators can
disable, edit limits, rotate or permanently revoke an integration. Rotation
immediately invalidates the previous key and gives the replacement a 90-day
lifetime. Already-admitted requests may finish after these changes.
Concurrent admin edits use a version check and return 409 rather than overwrite.

**Do not embed keys in browser JavaScript, mobile binaries, URLs, source control
or logs.** Clients call their own backend, which authenticates users, applies
per-user limits and forwards permitted chat requests here. Integration keys
identify an application backend, not an individual user.
The v1 route does not enable CORS and rejects Origin-bearing requests. This is a
browser guard, not proof that a caller is a trusted server. Use HTTPS in production.
A key authorizes chat only, never administration.

## Request And Response

~~~bash
curl --fail-with-body https://chat.nrep.ug/api/v1/chat \
  -H "Authorization: Bearer $REC_CHAT_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"question":"When will the conference take place?","stream":false}'
~~~

~~~json
{
  "answer": "Markdown-formatted answer",
  "sources": [],
  "cached": false,
  "requestId": "server-generated-request-id"
}
~~~

Successful JSON answers always contain answer and sources. Optional cached and
validationFallback fields indicate caching or a verified fallback. A validation
fallback is degraded, not successful model synthesis. Sources are the existing
engine's public attribution objects. Render title and safe HTTP(S) url values
when available; other metadata is optional. Treat Markdown as untrusted: disable
raw HTML and unsafe URL schemes.

| Field | Request contract |
| --- | --- |
| question | Required string, 2 to 4,000 characters by default |
| history | Optional recent turns with role (user or assistant) and content |
| stream | Optional boolean; defaults to false |

Default history limits: 8 messages, 1,200 characters per message and 4,800
characters total. Oversized history is rejected by v1, not silently truncated.
The caller retains its conversation and sends a bounded recent window; never
mix histories between users. This API does not persist transcripts or create
conversation records. Unknown fields, system roles, invalid JSON, compressed
bodies and bodies over 32 KiB are rejected. Environment settings can change these
limits; OpenAPI describes the default deployment.

## Streaming

Send stream: true and consume the POST body as SSE. Use a streaming HTTP client
in your backend; browser EventSource cannot supply this POST body and Bearer header.

~~~text
: connected

event: sources
data: []

event: token
data: "**REC26 & EXPO**"

event: done
data: {"cached":false}
~~~

Data values are JSON. Append decoded token strings, replace attribution on sources,
and accept completion only after done. Ignore comment heartbeats. An error event
contains an error string and may include code and requestId. After streaming
headers, HTTP status remains 200 even on errors: inspect terminal events.
A connection ending without done or error is incomplete. Packets may split
events and UTF-8 characters. Some answers are verified before any answer tokens
are emitted; heartbeats are not answer content. Cancelling cancels upstream work.

## Errors And Capacity

Before streaming starts, v1 errors have this shape:

~~~json
{
  "error": { "code": "rate_limit_exceeded", "message": "Request limit reached for this minute." },
  "code": "rate_limit_exceeded",
  "requestId": "server-generated-request-id"
}
~~~

| HTTP status | Meaning |
| --- | --- |
| 400 | Invalid question, history or request shape |
| 401 | Missing, malformed, rotated or revoked key |
| 403 | Disabled/expired integration or browser request |
| 408 | Request body read timed out |
| 413 / 415 | Oversized body / unsupported media type or encoding |
| 429 | Per-minute, UTC daily or integration concurrency limit |
| 503 | Shared capacity reached or API store unavailable |
| 504 | Answer deadline exceeded |

Responses include X-Request-Id; admitted requests also include X-RateLimit-Limit
and X-RateLimit-Remaining for the current fixed UTC minute. Capacity/quota errors
include Retry-After in seconds. Respect it, add jitter and cap retries. Do not
automatically retry 400/401/403. A timed-out or cancelled admitted attempt still
consumes quota. Cached answers count too. There is no idempotency replay:
retrying creates a new request and may consume quota.

The default global ceiling is **two simultaneous chat requests**, including the
existing public /api/chat. All admitted calls use slots, not just model calls.
Excess requests fail fast; there is no unbounded queue. Tune this on measured VPS
load. Per-integration concurrency cannot override the global ceiling.
The answer deadline defaults to 180 seconds.

## Deployment And Storage

Use Node **22.13 or newer**, preferably Node 24 LTS. Built-in node:sqlite is
required; some supported Node versions emit its experimental warning. No Redis
service or native npm addon is needed.

Example production settings in the chatbot's .env.local:

~~~dotenv
ADMIN_APP_ORIGIN=https://chat.nrep.ug
CHAT_API_DB_FILE=data/admin/integrations.sqlite
CHAT_API_MAX_CONCURRENT=2
CHAT_API_TIMEOUT_MS=180000
CHAT_API_MAX_BODY_BYTES=32768
CHAT_PUBLIC_REQUESTS_PER_MINUTE=20
CHAT_PUBLIC_REQUESTS_PER_DAY=500
CHAT_API_TRUSTED_IP_HEADER=x-real-ip
~~~

Only configure CHAT_API_TRUSTED_IP_HEADER after the reverse proxy overwrites it
with the actual connecting IP and the Node port is firewalled against direct
public access. Otherwise leave it blank: public clients share one quota, and
arbitrary forwarded headers cannot bypass it. A single IP is expected, not a
comma-separated chain. Add proxy-level request/body/connection limits for
invalid-key floods and slow uploads; application quotas do not replace those.
Set proxy response timeouts above the API deadline and disable SSE buffering.
ADMIN_APP_ORIGIN is the external admin origin, without a trailing slash.
The backend-only key route requires no website domain registration.
For the `chat.nrep.ug` nginx site, configure unbuffered exact-match locations
for both `/api/chat` and `/api/v1/chat` as shown in the README's Reverse Proxy
Notes. The current `/api/chat` location does not cover `/api/v1/chat`.

SQLite credentials, quotas, request leases and audit records are shared atomically
by PM2 workers on one VPS. Values use SQL parameter binding. Dead-worker leases
expire after the deadline plus five seconds. Upstream work must honor cancellation;
process-level failures may need service recovery. Do not put the DB on NFS.
For multi-host deployment, migrate this store to a transactional shared database.

The directory and DB are created with restrictive POSIX permissions; protect the
directory and Windows ACLs where applicable. SQLite files and WAL sidecars are
Git-ignored. Never expose data/admin via a web server. Use SQLite-aware backups,
or stop **all** chatbot workers and copy the database and remaining sidecars
together. Never copy only the live main database while WAL writes are active.
Restore with all workers stopped.

Usage retains 30 UTC days and is cleaned during admission. Audit retains 500
admin changes; the UI displays the most recent 30, with eight on Overview.
Usage records admitted/completed/failed/cancelled/degraded counts and total
duration. Rejections are not admitted usage. Mean duration is not a percentile
or model-only metric. No keys, prompts or responses are stored in this registry.
Registered-client request-start diagnostics omit questions. Existing public
diagnostics may include question excerpts when explicitly enabled.

## Verification

The automated tests cover credentials, expiry, rotation, revocation, validation,
CSRF, body limits, quotas, cross-process concurrency, JSON/SSE, incomplete streams,
deadlines and cancellation without model inference.

Verify a deployed key with question "hello" first; it needs no model inference.
Then check a conference question and a streamed request. Disable and rotate a
test integration and confirm the old key fails. Never share secrets in logs.
The existing eval:chat command remains available but consumes public quota; allow
for repeated runs.

See [OpenAPI](../public/rec-chat.openapi.json) for client tooling.
References: [Node SQLite](https://nodejs.org/api/sqlite.html) and
[OWASP REST security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).
