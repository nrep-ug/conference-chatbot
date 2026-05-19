# Conference Chatbot

A Next.js conference assistant that answers questions from local conference documents using:

- Next.js App Router for the web UI and `/api/chat` route
- Ollama for local embeddings and chat completion
- Qdrant for vector search over conference materials
- PM2 for self-hosted production deployment

The current chat route streams responses to the browser, keeps Ollama models warm, limits prompt size, and caches repeated answers in memory.

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
CHAT_MODEL=gemma2:2b
EMBED_MODEL=nomic-embed-text

QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=conference_docs

PORT=3000

CHAT_KEEP_ALIVE=30m
EMBED_KEEP_ALIVE=30m
CHAT_NUM_CTX=1024
CHAT_NUM_PREDICT=160
CHAT_NUM_THREAD=12

RAG_SEARCH_LIMIT=1
RAG_MAX_CONTEXT_CHARS=1600
ANSWER_CACHE_TTL_MS=300000
ANSWER_CACHE_MAX=100
```

`.env.local` is the single source of runtime environment values. The PM2 ecosystem file reads it directly and passes those values to the app.

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

Source files live in:

```text
data/conference/
```

The ingestion script reads Markdown files from this folder, chunks them, embeds them with Ollama, recreates the Qdrant collection, and upserts the vectors.

After changing conference content, run:

```bash
npm run ingest
```

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
CHAT_NUM_THREAD=12
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
- confirm the model is already pulled with `ollama list`
- keep `CHAT_KEEP_ALIVE=30m` or higher
- reduce `CHAT_NUM_PREDICT` for shorter answers
- keep `RAG_SEARCH_LIMIT=1` unless the documents grow and need broader retrieval

If ingestion fails:

- confirm Qdrant is running at `QDRANT_URL`
- confirm Ollama is running at `OLLAMA_URL`
- confirm `EMBED_MODEL` exists in `ollama list`
- check that Markdown files exist in `data/conference/`

If PM2 fails to start:

- confirm `.env.local` exists in the project root
- confirm `PORT` is set in `.env.local`
- run `npm run build` before `pm2 start`
