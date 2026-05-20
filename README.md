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

CHAT_MODEL=gemma2:2b
PLANNER_MODEL=gemma2:2b
EMBED_MODEL=nomic-embed-text

QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=conference_docs

PORT=3000

CHAT_KEEP_ALIVE=30m
EMBED_KEEP_ALIVE=30m
CHAT_NUM_CTX=1024
CHAT_NUM_PREDICT=160
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

RAG_SEARCH_LIMIT=1
RAG_MAX_CONTEXT_CHARS=1600
RAG_MIN_SEARCH_SCORE=0.52
QDRANT_COMPLEMENT_ENABLED=false
QDRANT_COMPLEMENT_MODE=append
QDRANT_COMPLEMENT_SEARCH_LIMIT=3
QDRANT_COMPLEMENT_MAX_CONTEXT_CHARS=2400
QDRANT_COMPLEMENT_MIN_SCORE=0.52
QDRANT_COMPLEMENT_SNIPPET_CHARS=700
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
npm run ingest
```

Start the development server:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Conference Data

The source of truth is the `HR` Appwrite database:

- `REC_Conferences`
- `REC_Program`
- `REC_ProgramTimeBlocks`
- `REC_Sessions`
- `REC_SponsorCategories`
- `REC_Sponsors`

The chatbot intentionally does not ingest private registration/security tables such as `REC_Registrations`, `REC_Reg_Coupon`, `REC Registration Locks`, or `REC Registration Verifications`.

The ingestion script reads public REC data from Appwrite, converts it into clean text documents, embeds those documents with Ollama, recreates the Qdrant collection, and upserts the vectors.

After changing public conference content in Appwrite, run:

```bash
npm run ingest
```

The chat route uses this order:

1. Scope guard for greetings and off-topic questions.
2. Direct Appwrite answers for deterministic facts such as venue, dates, registration status, contact details, capacity, fees, website, sponsors, and common programme questions.
3. Optional Qdrant complement for broad direct answers such as detailed overviews, session summaries, learning questions, and technology-area questions. Appwrite still provides the authoritative answer; Qdrant only adds indexed supporting context. Set `QDRANT_COMPLEMENT_ENABLED=true` to enable it. The default `QDRANT_COMPLEMENT_MODE=append` avoids a second chat-model call; use `model` only if you want the model to rewrite the direct answer with Qdrant context.
4. Planner lookup for richer cross-table questions. The human-readable schema lives in `docs/conference-schema.md`; the runtime planner receives a compact schema prompt from `src/lib/rec-schema.js`, returns a strict JSON plan, and `src/lib/rec-planner.js` validates the requested tables, fields, filters, sorting, and limits before retrieving public REC26 data.
5. Qdrant semantic search as a fallback.
6. The answer model responds only from the retrieved context.

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
npm run ingest   # Rebuild the Qdrant vector collection
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

For the target VPS with 14 CPU cores and 16 GB RAM, the recommended default is:

```bash
CHAT_MODEL=gemma2:2b
PLANNER_MODEL=gemma2:2b
CHAT_NUM_THREAD=12
PLANNER_NUM_THREAD=12
RAG_SEARCH_LIMIT=1
RAG_MAX_CONTEXT_CHARS=1600
```

This keeps responses fast for the current conference QA workload while leaving CPU headroom for Next.js, Qdrant, and the operating system.

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

- confirm `CHAT_MODEL=gemma2:2b`
- confirm `PLANNER_MODEL` is pulled if it differs from `CHAT_MODEL`
- confirm the model is already pulled with `ollama list`
- keep `CHAT_KEEP_ALIVE=30m` or higher
- reduce `CHAT_NUM_PREDICT` for shorter answers
- keep `RAG_SEARCH_LIMIT=1` unless the documents grow and need broader retrieval

If ingestion fails:

- confirm `APPWRITE_API_KEY` is set in `.env.local`
- confirm the Appwrite key can read the public REC tables
- confirm Qdrant is running at `QDRANT_URL`
- confirm Ollama is running at `OLLAMA_URL`
- confirm `EMBED_MODEL` exists in `ollama list`

If PM2 fails to start:

- confirm `.env.local` exists in the project root
- confirm `PORT` is set in `.env.local`
- run `npm run build` before `pm2 start`
