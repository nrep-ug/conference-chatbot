import { getEmbedding, askMistral, streamMistral } from "@/lib/ollama";
import { qdrant, QDRANT_COLLECTION } from "@/lib/qdrant";

export const runtime = "nodejs";

const SEARCH_LIMIT = readInteger("RAG_SEARCH_LIMIT", 1);
const MAX_CONTEXT_CHARS = readInteger("RAG_MAX_CONTEXT_CHARS", 1600);
const ANSWER_CACHE_TTL_MS = readInteger("ANSWER_CACHE_TTL_MS", 5 * 60 * 1000);
const ANSWER_CACHE_MAX = readInteger("ANSWER_CACHE_MAX", 100);
const answerCache = new Map();

function readInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeQuestion(question) {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

function getCachedAnswer(question) {
  const key = normalizeQuestion(question);
  const cached = answerCache.get(key);

  if (!cached) return null;

  if (Date.now() - cached.createdAt > ANSWER_CACHE_TTL_MS) {
    answerCache.delete(key);
    return null;
  }

  answerCache.delete(key);
  answerCache.set(key, cached);
  return cached.payload;
}

function setCachedAnswer(question, payload) {
  if (ANSWER_CACHE_TTL_MS <= 0 || ANSWER_CACHE_MAX <= 0) return;

  const key = normalizeQuestion(question);
  answerCache.set(key, {
    createdAt: Date.now(),
    payload,
  });

  while (answerCache.size > ANSWER_CACHE_MAX) {
    const oldestKey = answerCache.keys().next().value;
    answerCache.delete(oldestKey);
  }
}

function formatContext(searchResults) {
  let remaining = MAX_CONTEXT_CHARS;
  const chunks = [];

  for (const result of searchResults) {
    if (remaining <= 0) break;

    const text = String(result.payload?.text || "").trim();
    if (!text) continue;

    const chunk = text;
    chunks.push(chunk.slice(0, remaining));
    remaining -= chunk.length;
  }

  return chunks.join("\n\n");
}

function formatSources(searchResults) {
  return searchResults.map((result) => ({
    source: result.payload?.source,
    score: result.score,
  }));
}

async function retrieveContext(question, signal) {
  const queryVector = await getEmbedding(`search_query: ${question}`, {
    signal,
  });

  const searchResults = await qdrant.search(QDRANT_COLLECTION, {
    vector: queryVector,
    limit: SEARCH_LIMIT,
    with_payload: true,
  });

  return {
    context: formatContext(searchResults),
    sources: formatSources(searchResults),
  };
}

async function answerQuestion(question, signal) {
  const cached = getCachedAnswer(question);
  if (cached) {
    return { ...cached, cached: true };
  }

  const { context, sources } = await retrieveContext(question, signal);
  const answer = await askMistral({
    question,
    context,
    signal,
  });
  const payload = { answer, sources };

  setCachedAnswer(question, payload);
  return payload;
}

function writeEvent(controller, encoder, event, data) {
  controller.enqueue(
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  );
}

function streamAnswer(question, signal) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const cached = getCachedAnswer(question);

          if (cached) {
            writeEvent(controller, encoder, "sources", cached.sources);
            writeEvent(controller, encoder, "token", cached.answer);
            writeEvent(controller, encoder, "done", { cached: true });
            controller.close();
            return;
          }

          const { context, sources } = await retrieveContext(question, signal);
          writeEvent(controller, encoder, "sources", sources);

          const answer = await streamMistral({
            question,
            context,
            signal,
            onToken: (token) => writeEvent(controller, encoder, "token", token),
          });

          setCachedAnswer(question, { answer, sources });
          writeEvent(controller, encoder, "done", { cached: false });
          controller.close();
        } catch (error) {
          console.error(error);
          writeEvent(controller, encoder, "error", {
            error: "The chatbot failed to process the question.",
          });
          controller.close();
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }
  );
}

export async function POST(request) {
  try {
    const { question, stream } = await request.json();

    if (!question || question.trim().length < 2) {
      return Response.json(
        { error: "Please provide a valid question." },
        { status: 400 }
      );
    }

    const normalizedQuestion = question.trim();

    if (stream) {
      return streamAnswer(normalizedQuestion, request.signal);
    }

    return Response.json(await answerQuestion(normalizedQuestion, request.signal));
  } catch (error) {
    console.error(error);

    return Response.json(
      { error: "The chatbot failed to process the question." },
      { status: 500 }
    );
  }
}
