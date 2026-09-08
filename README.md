# Conference Chatbot

A Next.js conference assistant that answers questions from local conference documents using:

- Next.js App Router for the web UI and `/api/chat` route
- Appwrite TablesDB as the source of truth for REC & EXPO data
- Ollama for local embeddings and chat completion
- Qdrant as a derived vector index over public Appwrite conference data
- PM2 for self-hosted production deployment

The chat route streams responses to the browser, answers exact public conference facts from a generated Appwrite snapshot, supports explicitly selected previous REC editions, media, and reports, can use a planner model for unresolved questions, keeps Ollama models warm, limits prompt size, and caches repeated answers in memory.

## Requirements

- Node.js with built-in `fetch` and `--env-file` support
- npm
- Docker and Docker Compose for Qdrant
- Ollama installed and running
- PM2 for production process management

Install the expected Ollama models:

```bash
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```

## Environment

Create `.env.local` from the example file:

```bash
cp .env.example .env.local
```

Key variables:

```bash
OLLAMA_URL=http://localhost:11434
OLLAMA_TIMEOUT_MS=120000

APPWRITE_ENDPOINT=https://appwrite.nrep.ug/v1
APPWRITE_PROJECT_ID=66bcc8450005201fa1af
APPWRITE_API_KEY=
APPWRITE_DATABASE_ID=66bcc8760033a24883f6
APPWRITE_REC_CONFERENCES_TABLE_ID=6863ae070028061694f1
APPWRITE_REC_PROGRAM_TABLE_ID=68e62391001de7d5c9be
APPWRITE_REC_PROGRAM_TIME_BLOCKS_TABLE_ID=rec_program_time_blocks
APPWRITE_REC_SESSIONS_TABLE_ID=68e60fc1003b0bbb05d8
APPWRITE_REC_SPONSOR_CATEGORIES_TABLE_ID=rec_sponsor_categories
APPWRITE_REC_SPONSORS_TABLE_ID=rec_sponsors
APPWRITE_REC_MEDIA_ITEMS_TABLE_ID=rec_media_items
APPWRITE_REC_CONFERENCE_REPORTS_TABLE_ID=rec_conference_reports
APPWRITE_TIMEOUT_MS=30000
REC_DATA_CACHE_TTL_MS=300000
REC_SNAPSHOT_ENABLED=true
REC_SNAPSHOT_STRICT=false
REC_REFRESH_TOKEN=

ADMIN_AUTH_FILE=data/admin/admin-users.json
CONFERENCE_KNOWLEDGE_FILE=data/admin/conference-knowledge.json
ADMIN_AUTH_SECRET=
ADMIN_SESSION_TTL_MS=604800000
ADMIN_LOGIN_CODE_TTL_MS=600000
ADMIN_LOGIN_CODE_COOLDOWN_MS=60000

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_STARTTLS=true
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=

CHAT_MODEL=qwen2.5:7b
PLANNER_MODEL=qwen2.5:7b
EMBED_MODEL=nomic-embed-text

QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=conference_docs

PORT=3000

CHAT_KEEP_ALIVE=30m
EMBED_KEEP_ALIVE=30m
CHAT_NUM_CTX=8192
CHAT_NUM_PREDICT=360
CHAT_NUM_THREAD=12
CHAT_MAX_QUESTION_CHARS=4000
CHAT_HISTORY_MAX_MESSAGES=8
CHAT_HISTORY_MAX_MESSAGE_CHARS=1200
CHAT_HISTORY_MAX_TOTAL_CHARS=4800
PLANNER_ENABLED=true
PLANNER_KEEP_ALIVE=30m
PLANNER_NUM_CTX=2048
PLANNER_NUM_PREDICT=220
PLANNER_TEMPERATURE=0
PLANNER_NUM_THREAD=12
PLANNER_MAX_OPERATIONS=4
PLANNER_MAX_ROWS_PER_OPERATION=12
PLANNER_MAX_CONTEXT_CHARS=3200
PLANNER_SCHEMA_MAX_CHARS=2200

REC_FULL_CONTEXT_ENABLED=true
REC_FULL_CONTEXT_MODE=fallback
REC_FULL_CONTEXT_MAX_CHARS=18000
REC_FULL_CONTEXT_SCHEMA_MAX_CHARS=2500
RAG_SEARCH_LIMIT=1
RAG_MAX_CONTEXT_CHARS=1600
RAG_MIN_SEARCH_SCORE=0.52
QDRANT_COMPLEMENT_ENABLED=false
QDRANT_COMPLEMENT_MODE=append
QDRANT_COMPLEMENT_SEARCH_LIMIT=3
QDRANT_COMPLEMENT_MAX_CONTEXT_CHARS=2400
QDRANT_COMPLEMENT_MIN_SCORE=0.52
QDRANT_COMPLEMENT_SNIPPET_CHARS=700
QDRANT_FULL_CONTEXT_ENABLED=false
QDRANT_FULL_CONTEXT_MODE=broad
QDRANT_FULL_CONTEXT_MAX_CHARS=12000
QDRANT_FULL_CONTEXT_SCROLL_LIMIT=128
ANSWER_CACHE_TTL_MS=300000
ANSWER_CACHE_MAX=100
CHAT_DIAGNOSTIC_LOGS=false
```

`.env.local` is the single source of runtime environment values. The PM2 ecosystem file reads it directly and passes those values to the app.

Keep `APPWRITE_API_KEY` server-only. It is used by ingestion and API routes, and it must never be exposed with a `NEXT_PUBLIC_` prefix.

## Local Setup

Install dependencies:

```bash
npm install
```

Start Qdrant:

```bash
docker compose up -d
```

Make sure Ollama is running:

```bash
ollama serve
```

Ingest the conference documents:

```bash
npm run export:rec
npm run ingest
```

Start the development server:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Admin Console

The admin console is available at `/admin`.

It provides:

- secure setup for allowed admin emails
- email verification codes over SMTP
- client-side password digest before transport plus server-side `scrypt` storage in JSON
- HttpOnly session cookies
- snapshot refresh and optional Qdrant rebuild controls
- active-conference venue and visitor knowledge with draft/published states
- historical conference, media, and report counts
- runtime status for models, Qdrant, SMTP, and generated REC data

Runtime account data is stored in `data/admin/admin-users.json`, which is ignored by git. The tracked seed file is `data/admin/admin-users.example.json`.

Admin-managed public visitor facts are stored in `data/admin/conference-knowledge.json`, which is also ignored by git. Its tracked seed is `data/admin/conference-knowledge.example.json`. Entries are always bound server-side to the active conference. Incomplete entries can be saved as drafts, while publishing requires a valid category, public topic, public answer, and at least one matching keyword. Only valid entries marked **Published** are added to chatbot context and Qdrant. Store only public guest information here; do not add staff networks, internal systems, or private credentials.

Before first production use:

```bash
cp data/admin/admin-users.example.json data/admin/admin-users.json
```

Then edit `data/admin/admin-users.json` and replace `admin@example.com` with the allowed admin email address. Keep `username`, `passwordHash`, and other account fields empty. The allowed user will complete setup from `/admin` after receiving an SMTP verification code.

Set these values in `.env.local`:

```bash
ADMIN_AUTH_SECRET=<long-random-secret>
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_STARTTLS=true
SMTP_USER=bot@example.com
SMTP_PASSWORD=<smtp-password>
SMTP_FROM=bot@example.com
```

`ADMIN_AUTH_SECRET` signs login codes and session tokens. If it is missing, the app falls back to other server secrets or a per-process secret, which can invalidate sessions after restart.

To publish venue or visitor guidance, open **Venue and visitor knowledge** in `/admin`, add a category, public topic, answer, and comma-separated matching keywords, then enable **Published**. **Save changes** updates the local snapshot immediately. **Save + rebuild Qdrant** also refreshes semantic retrieval and can take longer. Draft entries remain visible to admins but never enter public snapshots or vector documents.

## Conference Data

The source of truth is the `HR` Appwrite database:

- `REC_Conferences`
- `REC_Program`
- `REC_ProgramTimeBlocks`
- `REC_Sessions`
- `REC_SponsorCategories`
- `REC_Sponsors`
- `REC Media Items`
- `REC Conference Reports`

The chatbot intentionally does not ingest private registration/security tables such as `REC_Registrations`, `REC_Reg_Coupon`, `REC Registration Locks`, or `REC Registration Verifications`.

Public conference data is exported into generated local snapshot files:

- `data/generated/rec-current.json` is a normalized, machine-readable snapshot containing the active conference, its published operational information, and available previous editions.
- `data/generated/rec-current.md` is a human-readable generated context file for inspection and LLM/vector context.

These files are generated artifacts and are ignored by git. Appwrite remains the source of truth.

The JSON snapshot uses conference-centric schema version `3.1` instead of exposing raw Appwrite rows. Its top level contains active-conference facts such as dates, venue, registration status, theme, website, and contact details. `program` groups time blocks and non-draft sessions by conference day, `sponsors` groups active sponsors under active categories, `operationalInfo` contains published admin visitor facts, and `media` and `reports` contain published current-edition resources. `previousConferences` contains normalized public historical editions with their programmes, sponsors, media, and reports. Sessions are included only when they belong to a time block where `allowSessions=true`; reports are included only when `isPublished=true`.

Each normalized time block and session includes a readable time such as `8:30 am` and its original ISO timestamp in `startAt`/`endAt`. Internal IDs are retained only where needed for source tracing and relationship validation. The runtime adapter accepts the legacy collection-shaped snapshot plus normalized schema versions `2.0`, `3.0`, and `3.1`, so an existing VPS snapshot remains readable until the next refresh.

At runtime, the chatbot reads `rec-current.json` first when `REC_SNAPSHOT_ENABLED=true`. If the file is missing or invalid, it falls back to Appwrite unless `REC_SNAPSHOT_STRICT=true`.

The active conference remains the default. Historical data is selected only by explicit scope, for example `What was the REC24 theme?`, `Compare REC25 and REC26`, `Show photos from 2023`, `Can I download the REC25 conference report?`, or `Tell me about previous conferences`. A current-conference question does not silently mix prior-edition data.

The ingestion script reads the same runtime snapshot, converts active and historical public data into clean text documents, embeds those documents with Ollama, recreates the Qdrant collection, and upserts the vectors. Qdrant payloads include `conferenceId`, `year`, `isActiveConference`, and a resource-specific `sourceType` such as `conference_media` or `conference_report`, so historical results remain distinguishable.

After changing public conference content in Appwrite, run:

```bash
npm run export:rec
npm run ingest
```

Or run both:

```bash
npm run refresh:rec
```

If you need to bypass the generated snapshot for one ingest run, set:

```bash
INGEST_FORCE_APPWRITE=true npm run ingest
```

The VPS can refresh the generated files through the protected API:

```bash
curl -X POST "https://your-domain.example/api/admin/rec-data/refresh" \
  -H "Authorization: Bearer $REC_REFRESH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rebuildQdrant":false}'
```

Set `"rebuildQdrant":true` only when you also want the API call to rebuild the vector collection. That can take longer because it calls the embedding model for every generated document.

Authenticated admins can also refresh the same data from `/admin` without using the token endpoint.

Both JSON and streaming requests use the same request preparation in `src/lib/rec-request.js`:

1. Acknowledge courtesy-only messages without a database or model call; apply the conference scope guard to other messages.
2. Resolve each request using bounded user history. Preserve the selected edition, programme topic, days, named sessions and relevant interests; explicit changes override earlier selections. Assistant messages are not authoritative facts.
3. Answer supported lookups directly from the public snapshot. Return a direct compound answer only when every parsed part has an answer. Unrecognized constraints and synthesis questions go to the model instead of being silently discarded. Session listings and day schedules are not silently cut to a handful of rows.
4. For synthesis, reserve evidence separately for every request and keep editions isolated. Rank public session descriptions and other relevant records within `REC_REQUEST_CONTEXT_MAX_CHARS` (default 9000), bounded by `REC_FULL_CONTEXT_MAX_CHARS` and an estimated model context budget. Label omitted evidence as partial; only included records contribute sources. Token estimates are conservative, not an exact model tokenizer.
5. When enabled, Qdrant adds supporting evidence to unresolved requests within the remaining budget. `QDRANT_COMPLEMENT_TIMEOUT_MS` (default 3000) bounds this optional enrichment. Complete structured answers do not receive an unrelated raw-context appendix or another model pass.
6. If request preparation is unavailable, retain the existing full-snapshot, full-Qdrant, validated planner, and semantic-search fallback paths. The `REC_FULL_CONTEXT_ENABLED`/`MODE` and `QDRANT_FULL_CONTEXT_ENABLED`/`MODE` switches control these fallback paths, not normal request-scoped retrieval. `QDRANT_COMPLEMENT_MODE` applies only to legacy direct-answer enrichment.

The planner requests JSON and rejects unknown tables and invented text filters. It joins session lookups to daily themes and reports both matched and included row counts; partial or empty operations are not treated as complete retrievals.

Official facts must come from the supplied evidence. Advice must be identified as advice. Finance recommendations cite terms present in published fields and flag overlapping sessions. `CHAT_NUM_PREDICT` is the base output budget; compound and comparative answers can expand up to `CHAT_MAX_NUM_PREDICT` (default 1024). Empty, interrupted, and token-limited model responses produce an explicit error and are never cached as finished answers. A changed snapshot file invalidates answer-cache keys.

Model-backed session selections are buffered until session-identity checks pass.
The checks reject daily themes presented as session names and answers missing
the expected published session titles. A rejected selection returns clearly
labelled public record examples instead, preserves other question parts, logs
`answer_validation_fallback`, and is not cached. This is a targeted safeguard,
not a general factual-verification engine; model answers still require evaluation.

The machine-readable schema allowlist lives in `src/lib/rec-schema.js`. Update both that file and `docs/conference-schema.md` when the public REC table structure changes.

## Planner Diagnostics

Set this on the VPS while testing:

```bash
CHAT_DIAGNOSTIC_LOGS=true
```

The app writes one-line JSON diagnostic events to stdout, which PM2 captures. Useful events include:

- `request_start`
- `request_coverage` (per-part intent, edition, days, direct/synthesis status and candidate record count)
- `request_complement_unavailable` (optional enrichment failed or timed out)
- `ollama_request_start`, `ollama_request_done`, `ollama_request_error` (model name, input size, context/output limits, loading, prompt evaluation and generation timings)
- `ollama_first_content` (generation has started, including for buffered/validated answers)
- `answer_direct_appwrite`
- `planner_executed`
- `planner_invalid_or_empty`
- `answer_planner_context`
- `answer_qdrant_context`
- `answer_out_of_scope_or_low_rag_score`
- `request_error`

To share a recent sample after testing on PM2:

```bash
pm2 logs rec-expo-chatbot --lines 200 --nostream
```

The diagnostic logs intentionally omit environment secrets and trim long values, but they can include the user's question and planner keywords. Turn `CHAT_DIAGNOSTIC_LOGS=false` after testing if you do not want prompt-level logs in production.

Each HTTP response includes `X-Request-Id`; the evaluator saves it so a slow answer
can be matched to PM2 events. Model timings use milliseconds: `loadMs` measures
loading, `promptEvalMs` measures prompt processing, and `generationMs` measures
output generation. `promptEvalCount`, `evalCount` and `generatedPerSecond` help
compare models and context sizes. `firstContentMs` measures the first streamed
content from Ollama, not the first byte sent to the browser. All chat/planner calls
consume Ollama's stream internally; `delivery: buffered` still withholds content
until completion and validation. `receivedChars` and `lastContentMs` show progress
on failed calls, without logging the generated text. `errorCode` distinguishes a
model deadline (`TimeoutError`), a cancelled request (`AbortError`), and transport
errors. Missing final load/prompt/generation metrics remain null on timeouts.
Public SSE responses send comments immediately and every 15 seconds during work;
comments are not answer tokens. Disconnecting the client cancels upstream work.
These counters come from the [Ollama chat API](https://docs.ollama.com/api/chat).

For slow VPS model requests, collect these while a request is running:

```bash
ollama ps
free -h
vmstat 1 10
pm2 logs rec-expo-chatbot --lines 200 --nostream
```

Long loading/prompt times need a memory, swap and CPU investigation before raising
timeouts. The evaluation report alone cannot distinguish those causes. Do not
share `.env.local`, API keys or SMTP credentials.

## Useful Scripts

```bash
npm run dev      # Start Next.js in development mode
npm run build    # Build the production app
npm run start    # Start the production app after building
npm run lint     # Run ESLint
npm test         # Run deterministic chatbot tests and ESLint
npm run eval:chat # Test the running HTTP API, including conversational follow-ups
npm run eval:chat -- --models # Also run slower model-backed synthesis checks
npm run export:rec # Export active and historical public REC data
npm run ingest   # Rebuild the Qdrant vector collection
npm run refresh:rec # Export public REC data, then rebuild Qdrant
```

## Production Deployment

Build the app:

```bash
npm run build
```

Start with PM2:

```bash
pm2 start pm2/ecosystem.config.js
pm2 save
```

The PM2 config:

- reads `../.env.local`
- uses `PORT` for `next start -p <PORT>`
- runs two clustered Next.js instances
- writes logs to `logs/pm2-out.log` and `logs/pm2-error.log`

RAM capacity and inference speed are different constraints. The September 2026
VPS sample showed `command-r` using about 20 GB on CPU, 36 GiB system RAM with
15 GiB available, and no swap activity during the sample, yet synthesis requests
still exceeded five minutes. More RAM alone is not an evidence-based fix for that
run. The [Command R model](https://ollama.com/library/command-r) has 35B parameters.

For a CPU-only benchmark, start with [Qwen2.5 7B](https://ollama.com/library/qwen2.5:7b)
(a 4.7 GB model download, not its total runtime allocation). This is a candidate
to evaluate, not a promise of latency or accuracy. Keep the embedding model unchanged
so Qdrant does not need re-ingestion. Update the following keys in the VPS `.env.local`:

```bash
CHAT_MODEL=qwen2.5:7b
PLANNER_MODEL=qwen2.5:7b
OLLAMA_TIMEOUT_MS=120000
CHAT_NUM_CTX=8192
CHAT_NUM_PREDICT=360
CHAT_NUM_THREAD=12
PLANNER_NUM_THREAD=12
REC_FULL_CONTEXT_ENABLED=true
REC_FULL_CONTEXT_MODE=fallback
REC_FULL_CONTEXT_MAX_CHARS=18000
REC_FULL_CONTEXT_SCHEMA_MAX_CHARS=2500
RAG_SEARCH_LIMIT=1
RAG_MAX_CONTEXT_CHARS=1600
QDRANT_COMPLEMENT_ENABLED=true
QDRANT_COMPLEMENT_MODE=append
QDRANT_FULL_CONTEXT_ENABLED=true
QDRANT_FULL_CONTEXT_MODE=broad
QDRANT_FULL_CONTEXT_MAX_CHARS=12000
```

Pull the candidate, rebuild after code changes, and reload the ecosystem file so
PM2 reads `.env.local` again. During a maintenance window, stop the old model
before benchmarking to avoid interference from previously timed-out work:

```bash
ollama pull qwen2.5:7b
pm2 stop rec-expo-chatbot
ollama stop command-r
npm run build
pm2 startOrReload pm2/ecosystem.config.js --update-env
npm run eval:chat -- --models
```

Check actual runtime allocation with `ollama ps`; model file size alone is insufficient.
Capture `nproc`, `lscpu` and `vmstat 1 10` while testing. Do not assume more threads
or more PM2 workers make model inference faster; measure on the actual VPS.
Request-scoped snapshot evidence avoids unnecessary planner calls and limits the
input size for unusual phrasing. Keep `CHAT_NUM_CTX` large enough for history,
evidence, instructions and the reserved output budget.

## Repeatable Evaluation

Run `npm test` before deployment. The suite covers scope inheritance, compound
coverage, unpublished data, recommendations, planner validation, Unicode cache
keys, and simulated interrupted/token-limited model responses without Ollama.

Start the application, then run `npm run eval:chat`. It checks both JSON and SSE
responses against the local public snapshot. By default it targets
`http://127.0.0.1:<PORT>/api/chat`, using `PORT` loaded from `.env.local` (3000 if
unset). An explicit `--base-url` takes precedence. To target a different deployment:

```bash
npm run eval:chat -- --base-url https://your-chatbot.example.org --models
npm run eval:chat -- --models --only Compare
```

The evaluator prints the target endpoint and waits up to 30 seconds for the chat
route to become ready after a PM2 reload. The readiness probe submits invalid input
to check the API validation contract without invoking a model or warming the answer
cache. Override that startup deadline with `--ready-timeout-ms 60000`; it is separate
from the per-question timeout and latency thresholds. If readiness fails, evaluation
stops with a nonzero exit code and writes an aborted `stage: "preflight"` report
with no question results. An `ECONNREFUSED` here means the HTTP endpoint could not
be reached, not that the chatbot answered incorrectly. Check the printed port,
`PORT` in `.env.local`, and `pm2 logs rec-expo-chatbot --lines 60 --nostream`.
PM2 showing `online` alone does not establish that the HTTP route is ready.

The snapshot used by the evaluator must match that deployment. Results are saved incrementally
under `logs/chat-evaluation-*.json`, including the endpoint, preflight status, answers, source references, first
token timings (streaming only), total latency, partial failed responses and failed assertions. Model cases
are marked for human review: keyword assertions do not prove factual accuracy or
recommendation quality. Review unsupported claims, omitted question parts and
schedule conflicts before considering a model/configuration validated. Reports
contain public test prompts and responses; keep them private if you add real user
conversations. No data re-ingestion is required for routing-only code changes.

Reports distinguish `checks_passed`, `degraded` (a validation fallback) and `failed`.
An answer is automatically `accepted` only if its checks pass without a fallback
and it meets the latency thresholds: 30 seconds total and 10 seconds to first
streamed content by default. Slow answers are flagged separately, even when their
keyword checks pass. Fallbacks, assertion failures and latency failures all produce
a nonzero exit code. Override thresholds explicitly with `--max-duration-ms` and
`--max-first-content-ms`; this changes evaluation acceptance, not server timeouts.
Human review is still required for model-backed advice and comparisons. A list of
recommended sessions alone no longer passes the business-evaluation question.
Cached responses are counted separately; restart the chatbot before an uncached
benchmark. Repeating cached prompts does not measure model inference speed.

Explicit session-topic lookups check titles, themes, descriptions, organizers and
speaker fields in the scoped public snapshot. A no-match answer is limited to an
explicit phrase not being found; it does not claim the subject cannot be discussed.
Comparisons and business advice use a bounded set of representative session titles;
identical details share occurrence slots, while differing speakers/descriptions
stay separate. Exhaustive requests retain the larger evidence budget and partial
coverage warnings. Qdrant complements skip database records already considered and
must carry an edition `year` matching the request, preventing unrelated editions
or untagged documents from being appended to scoped answers.

## Reverse Proxy Notes

Use nginx or another reverse proxy in front of Next.js in production.

Because `/api/chat` streams responses, disable proxy buffering for that route. The app also sets `X-Accel-Buffering: no` for `/api/chat`.

Example nginx location:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /api/chat {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_cache off;
  proxy_set_header Connection "";
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Troubleshooting

If answers are slow:

- confirm the configured model and its CPU/GPU placement with `ollama ps`
- use a measured smaller-model baseline on CPU; do not raise timeouts to hide slow inference
- confirm `PLANNER_MODEL` is pulled if it differs from `CHAT_MODEL`
- confirm the model is already pulled with `ollama list`
- keep `CHAT_KEEP_ALIVE=30m` or higher
- reduce `CHAT_NUM_PREDICT` for shorter answers
- keep `RAG_SEARCH_LIMIT=1` unless the documents grow and need broader retrieval

If ingestion fails:

- confirm `APPWRITE_API_KEY` is set in `.env.local`
- confirm the Appwrite key can read the public REC tables
- run `npm run export:rec` and inspect `data/generated/rec-current.json`
- confirm Qdrant is running at `QDRANT_URL`
- confirm Ollama is running at `OLLAMA_URL`
- confirm `EMBED_MODEL` exists in `ollama list`

If the refresh API returns `401`:

- confirm `REC_REFRESH_TOKEN` is set in `.env.local`
- pass it as `Authorization: Bearer <token>` or `x-rec-refresh-token`

If admin verification email fails:

- confirm `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`
- use `SMTP_SECURE=true` for SMTPS on port `465`
- use `SMTP_SECURE=false` and `SMTP_STARTTLS=true` for most port `587` SMTP providers
- confirm the allowed email exists in `data/admin/admin-users.json`

If PM2 fails to start:

- confirm `.env.local` exists in the project root
- confirm `PORT` is set in `.env.local`
- run `npm run build` before `pm2 start`
