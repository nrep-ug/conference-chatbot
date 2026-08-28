import { randomUUID } from "node:crypto";

import { logChatEvent } from "@/lib/chat-diagnostics";
import { getEmbedding, askMistral, streamMistral } from "@/lib/ollama";
import { qdrant, QDRANT_COLLECTION } from "@/lib/qdrant";
import {
  getDirectRecAnswer,
  getRecPublicSnapshot,
} from "@/lib/rec-data";
import { retrievePlannedRecContext } from "@/lib/rec-planner";
import { getPlannerSchemaMarkdown } from "@/lib/rec-schema";
import { renderRecSnapshotMarkdown } from "@/lib/rec-snapshot";

export const runtime = "nodejs";

const SEARCH_LIMIT = readInteger("RAG_SEARCH_LIMIT", 1);
const MAX_CONTEXT_CHARS = readInteger("RAG_MAX_CONTEXT_CHARS", 1600);
const MIN_SEARCH_SCORE = readFloat("RAG_MIN_SEARCH_SCORE", 0.52);
const ANSWER_CACHE_TTL_MS = readInteger("ANSWER_CACHE_TTL_MS", 5 * 60 * 1000);
const ANSWER_CACHE_MAX = readInteger("ANSWER_CACHE_MAX", 100);
const MAX_QUESTION_CHARS = readInteger("CHAT_MAX_QUESTION_CHARS", 4000);
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
const QDRANT_FULL_CONTEXT_ENABLED = readBoolean(
  "QDRANT_FULL_CONTEXT_ENABLED",
  false
);
const QDRANT_FULL_CONTEXT_MODE = (
  process.env.QDRANT_FULL_CONTEXT_MODE || "broad"
)
  .trim()
  .toLowerCase();
const QDRANT_FULL_CONTEXT_MAX_CHARS = readInteger(
  "QDRANT_FULL_CONTEXT_MAX_CHARS",
  12000
);
const QDRANT_FULL_CONTEXT_SCROLL_LIMIT = readInteger(
  "QDRANT_FULL_CONTEXT_SCROLL_LIMIT",
  128
);
const REC_FULL_CONTEXT_ENABLED = readBoolean("REC_FULL_CONTEXT_ENABLED", true);
const REC_FULL_CONTEXT_MODE = (process.env.REC_FULL_CONTEXT_MODE || "fallback")
  .trim()
  .toLowerCase();
const REC_FULL_CONTEXT_MAX_CHARS = readInteger(
  "REC_FULL_CONTEXT_MAX_CHARS",
  18000
);
const REC_FULL_CONTEXT_SCHEMA_MAX_CHARS = readInteger(
  "REC_FULL_CONTEXT_SCHEMA_MAX_CHARS",
  2500
);
const answerCache = new Map();
const CHATBOT_HELP_ANSWER = [
  "I can help with public information about the Renewable Energy Conference & Expo.",
  "",
  "**You can ask about:**",
  "- Dates, venue, halls, and logistics",
  "- Registration status, contacts, and website links",
  "- Programme sessions, themes, ceremonies, tea breaks, and lunch",
  "- Sponsors, partners, venue guidance, and practical preparation",
  "- Published programmes, media, and reports from previous REC editions",
  "",
  "I will say when official information is not listed in the conference materials.",
].join("\n");
const OUT_OF_SCOPE_ANSWER =
  "I’m here to help with the Renewable Energy Conference & Expo. Ask me about the venue, visitor guidance, dates, registration, programme sessions, themes, halls, sponsors, previous editions, media, reports, contacts, or website links.";
const CONFERENCE_TERMS =
  /\b(conference|rec(?:\s*[-']?\s*\d{2})?|expo|serena|venues?|locations?|visitors?|guests?|register|registration|programmes?|programs?|agenda|schedules?|sessions?|days?|themes?|speakers?|sponsors?|sponsorship|partners?|exhibitors?|halls?|rooms?|contacts?|websites?|fees?|cost|price|capacity|limits?|lunch|meals?|tea|breaks?|business forum|giz|fcdo|european union|technology|technologies|technical|ceremon(?:y|ies)|opening|closing|start|starts|starting|prepare|preparation|planning|maximize|maximise|clean cooking|cooking technolog(?:y|ies)|solar[- ]electric cooking|solco|biofuel|biofuels|geothermal|nuclear|productive use|energy efficiency|previous|past|historical|history|archive|photos?|images?|albums?|gallery|galleries|media|videos?|recordings?|reports?|documents?|publications?|proceedings|communiques?|outcomes|wifi|internet|parking|shuttle|accessibility|wheelchair|attire|dress code|first aid|bag policy|2022|2023|2024|2025|2026)\b/;
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

function getPayloadSortIndex(payload) {
  const chunkIndex = Number(payload?.chunk_index);

  return Number.isFinite(chunkIndex) ? chunkIndex : Number.MAX_SAFE_INTEGER;
}

function shouldUseFullQdrantContext(question) {
  if (!QDRANT_FULL_CONTEXT_ENABLED) return false;
  if (QDRANT_FULL_CONTEXT_MODE === "always") return true;

  const normalized = normalizeQuestion(question);

  return (
    /\b(in depth|in-depth|deep dive|detailed|comprehensive|full view|complete view|overview|summary)\b/.test(
      normalized
    ) ||
    /\btell me more\b/.test(normalized) ||
    /\b(across|over)\s+(the\s+)?(4|four)\s+days\b/.test(normalized) ||
    /\b(prepare|preparation|get ready|planning|make the most)\b/.test(
      normalized
    ) ||
    /\b(recommend|guide|what should|prioritize|prioritise|new to|beginner|learn|expect)\b/.test(
      normalized
    )
  );
}

function isBroadSynthesisQuestion(question) {
  const normalized = normalizeQuestion(question);

  return (
    /\b(in depth|in-depth|deep dive|detailed|comprehensive|full view|complete view|overview|summary)\b/.test(
      normalized
    ) ||
    /\btell me more\b/.test(normalized) ||
    /\b(across|over)\s+(the\s+)?(4|four)\s+days\b/.test(normalized) ||
    /\b(prepare|preparation|get ready|planning|make the most)\b/.test(
      normalized
    ) ||
    /\b(recommend|guide|what should|prioritize|prioritise|new to|beginner|learn|expect)\b/.test(
      normalized
    )
  );
}

function shouldUseFullRecContext(question) {
  if (!REC_FULL_CONTEXT_ENABLED) return false;
  if (REC_FULL_CONTEXT_MODE === "broad") return isBroadSynthesisQuestion(question);

  return true;
}

function sourceFromRecSnapshot(snapshot) {
  return {
    source: `${snapshot.conference.title} public data snapshot`,
    sourceType: "conference_snapshot",
    tableId: snapshot.conference.$tableId,
    rowId: snapshot.conference.$id,
    score: 1,
  };
}

async function retrieveFullRecContext(question, signal, requestId) {
  if (!shouldUseFullRecContext(question)) {
    return { confident: false, context: "", sources: [] };
  }

  const startedAt = Date.now();

  try {
    const snapshot = await getRecPublicSnapshot({ signal });
    const schema = getPlannerSchemaMarkdown().slice(
      0,
      REC_FULL_CONTEXT_SCHEMA_MAX_CHARS
    );
    const dataContext = renderRecSnapshotMarkdown(snapshot, { question }).slice(
      0,
      REC_FULL_CONTEXT_MAX_CHARS
    );

    if (!dataContext.trim()) {
      logChatEvent("full_rec_context_empty", {
        requestId,
        durationMs: Date.now() - startedAt,
      });

      return { confident: false, context: "", sources: [] };
    }

    const context = [
      "PUBLIC REC CONFERENCE DATABASE SCHEMA:",
      schema,
      "",
      "PUBLIC ACTIVE AND HISTORICAL CONFERENCE DATA SNAPSHOT:",
      dataContext,
      "",
      "Use the schema to understand table relationships. Default to the active conference unless the question explicitly selects a previous year or REC edition. Admin operational facts, historical media, and published conference reports in this snapshot are public.",
    ].join("\n");

    logChatEvent("full_rec_context_loaded", {
      requestId,
      durationMs: Date.now() - startedAt,
      sourceCount: 1,
      contextChars: context.length,
      mode: REC_FULL_CONTEXT_MODE,
    });

    return {
      confident: true,
      context,
      sources: [sourceFromRecSnapshot(snapshot)],
    };
  } catch (error) {
    logChatEvent("full_rec_context_error", {
      requestId,
      durationMs: Date.now() - startedAt,
      error: error.message,
    });

    return { confident: false, context: "", sources: [] };
  }
}

async function retrieveFullQdrantContext(question, requestId) {
  if (!shouldUseFullQdrantContext(question)) {
    return { confident: false, context: "", sources: [] };
  }

  const startedAt = Date.now();
  const points = [];
  let offset;

  try {
    do {
      const page = await qdrant.scroll(QDRANT_COLLECTION, {
        limit: QDRANT_FULL_CONTEXT_SCROLL_LIMIT,
        offset,
        with_payload: true,
        with_vector: false,
      });
      const batch = page.points || page.result?.points || [];
      points.push(...batch);
      offset = page.next_page_offset || page.result?.next_page_offset;
    } while (offset);
  } catch (error) {
    logChatEvent("full_qdrant_context_error", {
      requestId,
      durationMs: Date.now() - startedAt,
      error: error.message,
    });

    return { confident: false, context: "", sources: [] };
  }

  const sortedResults = points
    .filter((point) => point.payload?.text)
    .sort(
      (a, b) =>
        getPayloadSortIndex(a.payload) - getPayloadSortIndex(b.payload)
    );

  if (sortedResults.length === 0) {
    logChatEvent("full_qdrant_context_empty", {
      requestId,
      durationMs: Date.now() - startedAt,
    });

    return { confident: false, context: "", sources: [] };
  }

  const context = [
    "COMPLETE INDEXED PUBLIC REC CONFERENCE CONTEXT:",
    formatContext(sortedResults, QDRANT_FULL_CONTEXT_MAX_CHARS),
  ].join("\n");
  const sources = formatSources(sortedResults);

  logChatEvent("full_qdrant_context_loaded", {
    requestId,
    durationMs: Date.now() - startedAt,
    sourceCount: sources.length,
    contextChars: context.length,
  });

  return {
    confident: context.trim().length > 0,
    context,
    sources,
  };
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

function shouldComplementDirectAnswer(question, directAnswer) {
  if (!QDRANT_COMPLEMENT_ENABLED) return false;
  if (directAnswer?.retrievalPolicy?.qdrantComplement === false) return false;

  const normalized = normalizeQuestion(question);
  const sourceTypes = new Set(
    (directAnswer?.sources || []).map((source) => source.sourceType)
  );

  if (
    /\b(sponsors?|partners?|sponsorship|sponsor categories|sponsor tiers?)\b/.test(
      normalized
    ) ||
    sourceTypes.has("sponsor") ||
    sourceTypes.has("sponsor_category")
  ) {
    return false;
  }

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

  return [
    directAnswer.answer,
    "",
    "**Additional indexed context**",
    ...snippets.map((snippet) => `- ${snippet}`),
  ].join("\n");
}

async function complementDirectAnswer(question, directAnswer, signal, requestId, startedAt) {
  if (!shouldComplementDirectAnswer(question, directAnswer)) {
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

  const fullRecContext = await retrieveFullRecContext(question, signal, requestId);

  if (fullRecContext.confident) {
    const answerStartedAt = Date.now();
    const answer = await askMistral({
      question,
      context: fullRecContext.context,
      signal,
    });
    const payload = {
      answer,
      sources: fullRecContext.sources,
    };

    setCachedAnswer(question, payload);
    logChatEvent("answer_full_rec_context", {
      requestId,
      durationMs: Date.now() - startedAt,
      answerModelMs: Date.now() - answerStartedAt,
      sourceCount: fullRecContext.sources.length,
      contextChars: fullRecContext.context.length,
    });
    return payload;
  }

  const fullQdrantContext = await retrieveFullQdrantContext(question, requestId);

  if (fullQdrantContext.confident) {
    const answerStartedAt = Date.now();
    const answer = await askMistral({
      question,
      context: fullQdrantContext.context,
      signal,
    });
    const payload = {
      answer,
      sources: fullQdrantContext.sources,
    };

    setCachedAnswer(question, payload);
    logChatEvent("answer_full_qdrant_context", {
      requestId,
      durationMs: Date.now() - startedAt,
      answerModelMs: Date.now() - answerStartedAt,
      sourceCount: fullQdrantContext.sources.length,
      contextChars: fullQdrantContext.context.length,
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

function isRequestTimeout(error) {
  return (
    error?.name === "AbortError" ||
    /\b(aborted|timed? out|timeout)\b/i.test(error?.message || "")
  );
}

function getClientErrorMessage(error) {
  const message = error?.message || "";

  if (isRequestTimeout(error)) {
    return "The answer model took too long to respond. Please try the question again or ask for a narrower part of the conference programme.";
  }

  if (/\b(Chat|Planner|Embedding) failed\b/i.test(message)) {
    return "The conference data lookup is available, but the local AI model service is not ready. Please check that Ollama is running and that the configured chat/planner/embed models are installed on the server.";
  }

  return "The chatbot failed to process the question.";
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

          const fullRecContext = await retrieveFullRecContext(
            question,
            signal,
            requestId
          );

          if (fullRecContext.confident) {
            writeEvent(controller, encoder, "sources", fullRecContext.sources);

            const answerStartedAt = Date.now();
            const answer = await streamMistral({
              question,
              context: fullRecContext.context,
              signal,
              onToken: (token) =>
                writeEvent(controller, encoder, "token", token),
            });

            setCachedAnswer(question, {
              answer,
              sources: fullRecContext.sources,
            });
            writeEvent(controller, encoder, "done", { cached: false });
            logChatEvent("stream_full_rec_context", {
              requestId,
              durationMs: Date.now() - startedAt,
              answerModelMs: Date.now() - answerStartedAt,
              sourceCount: fullRecContext.sources.length,
              contextChars: fullRecContext.context.length,
            });
            controller.close();
            return;
          }

          const fullQdrantContext = await retrieveFullQdrantContext(
            question,
            requestId
          );

          if (fullQdrantContext.confident) {
            writeEvent(controller, encoder, "sources", fullQdrantContext.sources);

            const answerStartedAt = Date.now();
            const answer = await streamMistral({
              question,
              context: fullQdrantContext.context,
              signal,
              onToken: (token) =>
                writeEvent(controller, encoder, "token", token),
            });

            setCachedAnswer(question, {
              answer,
              sources: fullQdrantContext.sources,
            });
            writeEvent(controller, encoder, "done", { cached: false });
            logChatEvent("stream_full_qdrant_context", {
              requestId,
              durationMs: Date.now() - startedAt,
              answerModelMs: Date.now() - answerStartedAt,
              sourceCount: fullQdrantContext.sources.length,
              contextChars: fullQdrantContext.context.length,
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
            error: getClientErrorMessage(error),
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
    const body = await request.json().catch(() => null);
    const question = body?.question;
    const stream = body?.stream === true;

    if (typeof question !== "string" || question.trim().length < 2) {
      return Response.json(
        { error: "Please provide a valid question." },
        { status: 400 }
      );
    }

    const normalizedQuestion = question.trim();

    if (normalizedQuestion.length > MAX_QUESTION_CHARS) {
      return Response.json(
        {
          error: `Please keep the question under ${MAX_QUESTION_CHARS} characters.`,
        },
        { status: 400 }
      );
    }

    logChatEvent("request_start", {
      requestId,
      stream,
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
      { error: getClientErrorMessage(error) },
      { status: isRequestTimeout(error) ? 504 : 500 }
    );
  }
}
