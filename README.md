# Conference Chatbot

A Next.js conference assistant that answers questions from local conference documents using:

- Next.js App Router for the web UI and `/api/chat` route
- Appwrite TablesDB as the source of truth for REC & EXPO data
- Ollama for local embeddings and chat completion
- Qdrant as a derived vector index over public Appwrite conference data
- PM2 for self-hosted production deployment

The current chat route streams responses to the browser, answers exact public conference facts directly from Appwrite, can use a planner model to select REC tables before the answer model responds, keeps Ollama models warm, limits prompt size, and caches repeated answers in memory.

## Requirements

- Node.js with built-in `fetch` and `--env-file` support
- npm
- Docker and Docker Compose for Qdrant
- Ollama installed and running
- PM2 for production process management

Install the expected Ollama models:

```bash
ollama pull gemma2:2b
ollama pull command-r
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
APPWRITE_TIMEOUT_MS=30000
REC_DATA_CACHE_TTL_MS=300000
REC_SNAPSHOT_ENABLED=true
REC_SNAPSHOT_STRICT=false
REC_REFRESH_TOKEN=

ADMIN_AUTH_FILE=data/admin/admin-users.json
ADMIN_AUTH_SECRET=
ADMIN_SESSION_TTL_MS=604800000
ADMIN_LOGIN_CODE_TTL_MS=600000

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_STARTTLS=true
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=

CHAT_MODEL=command-r
PLANNER_MODEL=command-r
EMBED_MODEL=nomic-embed-text

QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=conference_docs

PORT=3000

CHAT_KEEP_ALIVE=30m
EMBED_KEEP_ALIVE=30m
CHAT_NUM_CTX=8192
CHAT_NUM_PREDICT=260
CHAT_NUM_THREAD=12
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
REC_FULL_CONTEXT_SCHEMA_MAX_CHARS=6000
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
- runtime status for models, Qdrant, SMTP, and generated REC data

Runtime account data is stored in `data/admin/admin-users.json`, which is ignored by git. The tracked seed file is `data/admin/admin-users.example.json`.

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

## Conference Data

The source of truth is the `HR` Appwrite database:

- `REC_Conferences`
- `REC_Program`
- `REC_ProgramTimeBlocks`
- `REC_Sessions`
- `REC_SponsorCategories`
- `REC_Sponsors`

The chatbot intentionally does not ingest private registration/security tables such as `REC_Registrations`, `REC_Reg_Coupon`, `REC Registration Locks`, or `REC Registration Verifications`.

The active public conference data is exported into generated local snapshot files:

- `data/generated/rec-current.json` is the machine-readable runtime snapshot.
- `data/generated/rec-current.md` is a human-readable generated context file for inspection and LLM/vector context.

These files are generated artifacts and are ignored by git. Appwrite remains the source of truth.

At runtime, the chatbot reads `rec-current.json` first when `REC_SNAPSHOT_ENABLED=true`. If the file is missing or invalid, it falls back to Appwrite unless `REC_SNAPSHOT_STRICT=true`.

The ingestion script reads the same runtime snapshot, converts it into clean text documents, embeds those documents with Ollama, recreates the Qdrant collection, and upserts the vectors.

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

The chat route uses this order:

1. Scope guard for greetings and off-topic questions.
2. Direct Appwrite answers for deterministic facts such as venue, dates, registration status, contact details, capacity, fees, website, sponsors, and common programme questions.
3. Optional Qdrant complement for broad direct answers such as detailed overviews, session summaries, learning questions, technology-area questions, and preparation questions. Appwrite still provides the authoritative answer; Qdrant only adds indexed supporting context. Set `QDRANT_COMPLEMENT_ENABLED=true` to enable it. The default `QDRANT_COMPLEMENT_MODE=append` avoids a second chat-model call; use `model` only if you want the model to rewrite the direct answer with Qdrant context.
4. Full public Appwrite/snapshot context for unresolved conference questions. `REC_FULL_CONTEXT_ENABLED=true` gives the answer model the public active-conference data plus the conference schema when the deterministic resolver does not know the requested answer shape. `REC_FULL_CONTEXT_MODE=fallback` applies this only after direct answers miss; `broad` restricts it to broad synthesis questions.
5. Optional full Qdrant context for broad/advisory questions. Set `QDRANT_FULL_CONTEXT_ENABLED=true` to give the answer model the complete indexed public REC26 dataset when the question needs synthesis rather than a single row lookup. `QDRANT_FULL_CONTEXT_MODE=broad` limits this to broad questions; `always` sends full context for every model-backed question.
6. Planner lookup for richer cross-table questions. The human-readable schema lives in `docs/conference-schema.md`; the runtime planner receives a compact schema prompt from `src/lib/rec-schema.js`, returns a strict JSON plan, and `src/lib/rec-planner.js` validates the requested tables, fields, filters, sorting, and limits before retrieving public REC26 data.
7. Qdrant semantic search as a fallback.
8. Official facts in model-backed answers must come from retrieved context. For preparation, planning, logistics, and recommendations, the model may add practical advice when it is clearly grounded in the context and not presented as an official conference fact.

The machine-readable schema allowlist lives in `src/lib/rec-schema.js`. Update both that file and `docs/conference-schema.md` when the public REC table structure changes.

## Planner Diagnostics

Set this on the VPS while testing:

```bash
CHAT_DIAGNOSTIC_LOGS=true
```

The app writes one-line JSON diagnostic events to stdout, which PM2 captures. Useful events include:

- `request_start`
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

## Useful Scripts

```bash
npm run dev      # Start Next.js in development mode
npm run build    # Build the production app
npm run start    # Start the production app after building
npm run lint     # Run ESLint
npm test         # Runs lint
npm run export:rec # Export active Appwrite REC data to data/generated/
npm run ingest   # Rebuild the Qdrant vector collection
npm run refresh:rec # Export active REC data, then rebuild Qdrant
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

For the target VPS with 14 CPU cores and 20 GB RAM, the recommended default is:

```bash
CHAT_MODEL=command-r
PLANNER_MODEL=command-r
CHAT_NUM_CTX=8192
CHAT_NUM_PREDICT=260
CHAT_NUM_THREAD=12
PLANNER_NUM_THREAD=12
REC_FULL_CONTEXT_ENABLED=true
REC_FULL_CONTEXT_MODE=fallback
REC_FULL_CONTEXT_MAX_CHARS=18000
REC_FULL_CONTEXT_SCHEMA_MAX_CHARS=6000
RAG_SEARCH_LIMIT=1
RAG_MAX_CONTEXT_CHARS=1600
QDRANT_COMPLEMENT_ENABLED=true
QDRANT_COMPLEMENT_MODE=append
QDRANT_FULL_CONTEXT_ENABLED=true
QDRANT_FULL_CONTEXT_MODE=broad
QDRANT_FULL_CONTEXT_MAX_CHARS=12000
```

For faster but smaller local models, `gemma2:2b` or `qwen2.5:3b` are still usable. With `command-r`, keep broad Qdrant complement in `append` mode unless you intentionally want a second model pass with `QDRANT_COMPLEMENT_MODE=model`. Full REC snapshot context is the preferred fallback for unusual phrasing because it uses the generated Appwrite source data directly; keep `CHAT_NUM_CTX` high enough for the selected model.

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

- confirm `CHAT_MODEL=command-r`
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
