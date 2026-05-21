import { randomUUID } from "node:crypto";

import { logChatEvent } from "@/lib/chat-diagnostics";
import { getEmbedding, askMistral, streamMistral } from "@/lib/ollama";
import { qdrant, QDRANT_COLLECTION } from "@/lib/qdrant";
import { getDirectRecAnswer } from "@/lib/rec-data";
import { retrievePlannedRecContext } from "@/lib/rec-planner";

export const runtime = "nodejs";

const SEARCH_LIMIT = readInteger("RAG_SEARCH_LIMIT", 1);
const MAX_CONTEXT_CHARS = readInteger("RAG_MAX_CONTEXT_CHARS", 1600);
const MIN_SEARCH_SCORE = readFloat("RAG_MIN_SEARCH_SCORE", 0.52);
const ANSWER_CACHE_TTL_MS = readInteger("ANSWER_CACHE_TTL_MS", 5 * 60 * 1000);
const ANSWER_CACHE_MAX = readInteger("ANSWER_CACHE_MAX", 100);
const QDRANT_COMPLEMENT_ENABLED = readBoolean("QDRANT_COMPLEMENT_ENABLED", false);
const QDRANT_COMPLEMENT_MODE = (process.env.QDRANT_COMPLEMENT_MODE || "append")
  .trim()
  .toLowerCase();
const QDRANT_COMPLEMENT_SEARCH_LIMIT = readInteger(
  "QDRANT_COMPLEMENT_SEARCH_LIMIT",
  3
);
const QDRANT_COMPLEMENT_MAX_CONTEXT_CHARS = readInteger(
  "QDRANT_COMPLEMENT_MAX_CONTEXT_CHARS",
  2400
);
const QDRANT_COMPLEMENT_MIN_SCORE = readFloat(
  "QDRANT_COMPLEMENT_MIN_SCORE",
  MIN_SEARCH_SCORE
);
const QDRANT_COMPLEMENT_SNIPPET_CHARS = readInteger(
  "QDRANT_COMPLEMENT_SNIPPET_CHARS",
  700
);
const answerCache = new Map();
const CHATBOT_HELP_ANSWER =
  "I can help with public information about the Renewable Energy Conference & Expo, including dates, venue, registration status, programme sessions, themes, halls, sponsors, contacts, and website links. I can only answer from the conference materials I have access to, so I will say when something is not listed.";
const OUT_OF_SCOPE_ANSWER =
  "I’m here to help with the Renewable Energy Conference & Expo. Ask me about the venue, dates, registration, programme sessions, themes, halls, sponsors, contacts, or website links.";
const CONFERENCE_TERMS =
  /\b(conference|rec|expo|serena|venue|location|register|registration|programme|program|agenda|schedule|session|day|theme|speaker|sponsor|exhibitor|hall|room|contact|website|fee|cost|price|capacity|limit|lunch|meal|tea|break|business forum|giz|fcdo|european union|technology|technologies|technical|ceremony|opening|closing|start|starts|starting|prepare|preparation|planning|maximize|maximise|clean cooking|cooking technolog(?:y|ies)|solar[- ]electric cooking|solco|biofuel|biofuels|geothermal|nuclear|productive use|energy efficiency)\b/;
const OFF_TOPIC_TERMS =
  /\b(joke|jazz|entertain|sing|song|poem|story|weather|news|sports|football|recipe|code|python|javascript|homework|essay|translate|summarize this|crypto|stock|president|politics|hotel|hotels)\b/;
const GENERAL_KNOWLEDGE_START =
  /^(what is|who is|explain|define|tell me about|how does|why is|where is)\b/;
const GREETING_ONLY =
  /^(hi|hello|hey|hey there|good morning|good afternoon|good evening|yo|sup|thanks|thank you)[\s!.?,]*$/;

function readInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readFloat(name, fallback) {
  const value = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(value) ? value : fallback;
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function normalizeQuestion(question) {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

function getAssistantScopeAnswer(question) {
  const normalized = normalizeQuestion(question);
  const hasConferenceTerms = CONFERENCE_TERMS.test(normalized);

  if (
    GREETING_ONLY.test(normalized) ||
    /^(hi|hello|hey|help|what can you do|how can you help|how can you assist|what do you do|who are you)\??$/.test(
      normalized
    ) ||
    /(what can you (help|assist)|how can you (help|assist)|what are you able to|what are your capabilities)/.test(
      normalized
    )
  ) {
    return {
      answer: CHATBOT_HELP_ANSWER,
      sources: [
        {
          source: "Conference chatbot scope",
          sourceType: "assistant_scope",
          score: 1,
        },
      ],
    };
  }

  if (!hasConferenceTerms && OFF_TOPIC_TERMS.test(normalized)) {
    return {
      answer: OUT_OF_SCOPE_ANSWER,
      sources: [
        {
          source: "Conference chatbot scope",
          sourceType: "assistant_scope",
          score: 1,
        },
      ],
    };
  }

  if (!hasConferenceTerms && GENERAL_KNOWLEDGE_START.test(normalized)) {
    return {
      answer: OUT_OF_SCOPE_ANSWER,
      sources: [
        {
          source: "Conference chatbot scope",
          sourceType: "assistant_scope",
          score: 1,
        },
      ],
    };
  }

  if (
    !hasConferenceTerms &&
    /^(hey|hi|hello|yo|sup|good morning|good afternoon|good evening)\b/.test(
      normalized
    )
  ) {
    return {
      answer: CHATBOT_HELP_ANSWER,
      sources: [
        {
          source: "Conference chatbot scope",
          sourceType: "assistant_scope",
          score: 1,
        },
      ],
    };
  }

  return null;
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

function summarizeQuestion(question) {
  return question.slice(0, 240);
}

function formatContext(searchResults, maxContextChars = MAX_CONTEXT_CHARS) {
  let remaining = maxContextChars;
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
    sourceType: result.payload?.sourceType,
    tableId: result.payload?.tableId,
    rowId: result.payload?.rowId,
    score: result.score,
  }));
}

async function retrieveContext(question, signal, options = {}) {
  const queryVector = await getEmbedding(`search_query: ${question}`, {
    signal,
  });
  const limit = options.limit || SEARCH_LIMIT;
  const minScore = options.minScore ?? MIN_SEARCH_SCORE;
  const maxContextChars = options.maxContextChars || MAX_CONTEXT_CHARS;

  const searchResults = await qdrant.search(QDRANT_COLLECTION, {
    vector: queryVector,
    limit,
    with_payload: true,
  });
  const topScore = searchResults[0]?.score || 0;

  if (topScore < minScore) {
    return {
      context: "",
      sources: [],
      confident: false,
      topScore,
    };
  }

  return {
    context: formatContext(searchResults, maxContextChars),
    sources: formatSources(searchResults),
    confident: true,
    topScore,
  };
}

function sourceKey(source) {
  return `${source?.sourceType || ""}:${source?.rowId || source?.source || ""}`;
}

function mergeSources(...sourceGroups) {
  const seen = new Set();
  const merged = [];

  for (const source of sourceGroups.flat()) {
    if (!source) continue;
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(source);
  }

  return merged;
}

function shouldComplementDirectAnswer(question) {
  if (!QDRANT_COMPLEMENT_ENABLED) return false;

  const normalized = normalizeQuestion(question);

  return (
    /\b(in depth|in-depth|deep dive|detailed|comprehensive|full view|complete view|overview|summary)\b/.test(
      normalized
    ) ||
    /\btell me more\b/.test(normalized) ||
    /\bmore about\b/.test(normalized) ||
    (/\bsessions?\b/.test(normalized) &&
      /\b(more|overview|summary|details|about)\b/.test(normalized)) ||
    /\b(what.*learn|expect.*learn|various renewable energy technolog|technology areas)\b/.test(
      normalized
    ) ||
    /\b(prepare|preparation|get ready|planning|make the most)\b/.test(
      normalized
    )
  );
}

function buildComplementContext(directAnswer, qdrantContext) {
  return [
    "AUTHORITATIVE APPWRITE ANSWER:",
    directAnswer.answer,
    "",
    "SUPPLEMENTAL INDEXED CONFERENCE CONTEXT:",
    qdrantContext,
    "",
    "Use the authoritative Appwrite answer as the base. Use supplemental context only to add relevant detail. Do not contradict the authoritative answer.",
  ].join("\n");
}

function truncateComplementSnippet(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();

  if (clean.length <= QDRANT_COMPLEMENT_SNIPPET_CHARS) {
    return clean;
  }

  return `${clean.slice(0, QDRANT_COMPLEMENT_SNIPPET_CHARS).trim()}...`;
}

function appendComplementContext(directAnswer, qdrantContext) {
  const snippets = qdrantContext
    .split(/\n{2,}/)
    .map(truncateComplementSnippet)
    .filter(Boolean)
    .filter((snippet) => !directAnswer.answer.includes(snippet))
    .slice(0, 2);

  if (snippets.length === 0) {
    return directAnswer.answer;
  }

  return `${directAnswer.answer}\n\nAdditional indexed context: ${snippets.join(" ")}`;
}

async function complementDirectAnswer(question, directAnswer, signal, requestId, startedAt) {
  if (!shouldComplementDirectAnswer(question)) {
    return null;
  }

  try {
    const retrieved = await retrieveContext(question, signal, {
      limit: QDRANT_COMPLEMENT_SEARCH_LIMIT,
      maxContextChars: QDRANT_COMPLEMENT_MAX_CONTEXT_CHARS,
      minScore: QDRANT_COMPLEMENT_MIN_SCORE,
    });

    if (!retrieved.confident || !retrieved.context) {
      return null;
    }

    const useModel = QDRANT_COMPLEMENT_MODE === "model";
    const answerStartedAt = Date.now();
    const answer = useModel
      ? await askMistral({
          question,
          context: buildComplementContext(directAnswer, retrieved.context),
          signal,
        })
      : appendComplementContext(directAnswer, retrieved.context);

    const payload = {
      answer: answer || directAnswer.answer,
      sources: mergeSources(directAnswer.sources, retrieved.sources),
    };

    logChatEvent("answer_direct_qdrant_complement", {
      requestId,
      durationMs: Date.now() - startedAt,
      answerModelMs: useModel ? Date.now() - answerStartedAt : 0,
      mode: useModel ? "model" : "append",
      directSourceCount: directAnswer.sources?.length || 0,
      qdrantSourceCount: retrieved.sources.length,
      contextChars: retrieved.context.length,
    });

    return payload;
  } catch (error) {
    logChatEvent("answer_direct_qdrant_complement_fallback", {
      requestId,
      durationMs: Date.now() - startedAt,
      error: error.message,
    });
    return null;
  }
}

async function answerQuestion(question, signal, requestId) {
  const startedAt = Date.now();
  const cached = getCachedAnswer(question);
  if (cached) {
    logChatEvent("answer_cache_hit", {
      requestId,
      durationMs: Date.now() - startedAt,
      sourceCount: cached.sources?.length || 0,
    });
    return { ...cached, cached: true };
  }

  const scopeAnswer = getAssistantScopeAnswer(question);

  if (scopeAnswer) {
    setCachedAnswer(question, scopeAnswer);
    logChatEvent("answer_scope_guard", {
      requestId,
      durationMs: Date.now() - startedAt,
    });
    return scopeAnswer;
  }

  const directAnswer = await getDirectRecAnswer(question, { signal });

  if (directAnswer) {
    const complementedAnswer = await complementDirectAnswer(
      question,
      directAnswer,
      signal,
      requestId,
      startedAt
    );
    const payload = complementedAnswer || directAnswer;

    setCachedAnswer(question, payload);
    logChatEvent("answer_direct_appwrite", {
      requestId,
      durationMs: Date.now() - startedAt,
      sourceCount: payload.sources?.length || 0,
      complemented: Boolean(complementedAnswer),
    });
    return payload;
  }

  const plannedContext = await retrievePlannedRecContext(question, {
    signal,
    requestId,
  });

  if (plannedContext.confident) {
    const answerStartedAt = Date.now();
    const answer = await askMistral({
      question,
      context: plannedContext.context,
      signal,
    });
    const payload = { answer, sources: plannedContext.sources };

    setCachedAnswer(question, payload);
    logChatEvent("answer_planner_context", {
      requestId,
      durationMs: Date.now() - startedAt,
      answerModelMs: Date.now() - answerStartedAt,
      sourceCount: plannedContext.sources.length,
      contextChars: plannedContext.context.length,
    });
    return payload;
  }

  const { context, sources, confident } = await retrieveContext(question, signal);

  if (!confident) {
    const payload = {
      answer: OUT_OF_SCOPE_ANSWER,
      sources: [],
    };
    setCachedAnswer(question, payload);
    logChatEvent("answer_out_of_scope_or_low_rag_score", {
      requestId,
      durationMs: Date.now() - startedAt,
    });
    return payload;
  }

  const answerStartedAt = Date.now();
  const answer = await askMistral({
    question,
    context,
    signal,
  });
  const payload = { answer, sources };

  setCachedAnswer(question, payload);
  logChatEvent("answer_qdrant_context", {
    requestId,
    durationMs: Date.now() - startedAt,
    answerModelMs: Date.now() - answerStartedAt,
    sourceCount: sources.length,
    contextChars: context.length,
  });
  return payload;
}

function writeEvent(controller, encoder, event, data) {
  controller.enqueue(
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  );
}

function streamAnswer(question, signal, requestId) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const startedAt = Date.now();

        try {
          const cached = getCachedAnswer(question);

          if (cached) {
            writeEvent(controller, encoder, "sources", cached.sources);
            writeEvent(controller, encoder, "token", cached.answer);
            writeEvent(controller, encoder, "done", { cached: true });
            logChatEvent("stream_cache_hit", {
              requestId,
              durationMs: Date.now() - startedAt,
              sourceCount: cached.sources?.length || 0,
            });
            controller.close();
            return;
          }

          const scopeAnswer = getAssistantScopeAnswer(question);

          if (scopeAnswer) {
            setCachedAnswer(question, scopeAnswer);
            writeEvent(controller, encoder, "sources", scopeAnswer.sources);
            writeEvent(controller, encoder, "token", scopeAnswer.answer);
            writeEvent(controller, encoder, "done", { cached: false });
            logChatEvent("stream_scope_guard", {
              requestId,
              durationMs: Date.now() - startedAt,
            });
            controller.close();
            return;
          }

          const directAnswer = await getDirectRecAnswer(question, { signal });

          if (directAnswer) {
            const complementedAnswer = await complementDirectAnswer(
              question,
              directAnswer,
              signal,
              requestId,
              startedAt
            );
            const payload = complementedAnswer || directAnswer;

            setCachedAnswer(question, payload);
            writeEvent(controller, encoder, "sources", payload.sources);
            writeEvent(controller, encoder, "token", payload.answer);
            writeEvent(controller, encoder, "done", { cached: false });
            logChatEvent("stream_direct_appwrite", {
              requestId,
              durationMs: Date.now() - startedAt,
              sourceCount: payload.sources?.length || 0,
              complemented: Boolean(complementedAnswer),
            });
            controller.close();
            return;
          }

          const plannedContext = await retrievePlannedRecContext(question, {
            signal,
            requestId,
          });

          if (plannedContext.confident) {
            writeEvent(controller, encoder, "sources", plannedContext.sources);

            const answerStartedAt = Date.now();
            const answer = await streamMistral({
              question,
              context: plannedContext.context,
              signal,
              onToken: (token) =>
                writeEvent(controller, encoder, "token", token),
            });

            setCachedAnswer(question, {
              answer,
              sources: plannedContext.sources,
            });
            writeEvent(controller, encoder, "done", { cached: false });
            logChatEvent("stream_planner_context", {
              requestId,
              durationMs: Date.now() - startedAt,
              answerModelMs: Date.now() - answerStartedAt,
              sourceCount: plannedContext.sources.length,
              contextChars: plannedContext.context.length,
            });
            controller.close();
            return;
          }

          const { context, sources, confident } = await retrieveContext(
            question,
            signal
          );

          if (!confident) {
            const payload = {
              answer: OUT_OF_SCOPE_ANSWER,
              sources: [],
            };
            setCachedAnswer(question, payload);
            writeEvent(controller, encoder, "sources", payload.sources);
            writeEvent(controller, encoder, "token", payload.answer);
            writeEvent(controller, encoder, "done", { cached: false });
            logChatEvent("stream_out_of_scope_or_low_rag_score", {
              requestId,
              durationMs: Date.now() - startedAt,
            });
            controller.close();
            return;
          }

          writeEvent(controller, encoder, "sources", sources);

          const answerStartedAt = Date.now();
          const answer = await streamMistral({
            question,
            context,
            signal,
            onToken: (token) => writeEvent(controller, encoder, "token", token),
          });

          setCachedAnswer(question, { answer, sources });
          writeEvent(controller, encoder, "done", { cached: false });
          logChatEvent("stream_qdrant_context", {
            requestId,
            durationMs: Date.now() - startedAt,
            answerModelMs: Date.now() - answerStartedAt,
            sourceCount: sources.length,
            contextChars: context.length,
          });
          controller.close();
        } catch (error) {
          console.error(error);
          logChatEvent("stream_error", {
            requestId,
            durationMs: Date.now() - startedAt,
            error: error.message,
          });
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
  const requestId = randomUUID();
  const startedAt = Date.now();

  try {
    const { question, stream } = await request.json();

    if (!question || question.trim().length < 2) {
      return Response.json(
        { error: "Please provide a valid question." },
        { status: 400 }
      );
    }

    const normalizedQuestion = question.trim();
    logChatEvent("request_start", {
      requestId,
      stream: Boolean(stream),
      question: summarizeQuestion(normalizedQuestion),
    });

    if (stream) {
      return streamAnswer(normalizedQuestion, request.signal, requestId);
    }

    const response = await answerQuestion(
      normalizedQuestion,
      request.signal,
      requestId
    );
    logChatEvent("request_done", {
      requestId,
      durationMs: Date.now() - startedAt,
      sourceCount: response.sources?.length || 0,
      cached: Boolean(response.cached),
    });

    return Response.json(response);
  } catch (error) {
    console.error(error);
    logChatEvent("request_error", {
      requestId,
      durationMs: Date.now() - startedAt,
      error: error.message,
    });

    return Response.json(
      { error: "The chatbot failed to process the question." },
      { status: 500 }
    );
  }
}
