import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { validateChatQuestion } from "../src/lib/chat-conversation.js";
import { readGeneratedRecSnapshot, snapshotToRuntimeData } from "../src/lib/rec-snapshot.js";

export function resolveEvaluationEndpoint(baseUrl, env = process.env) {
  if (!baseUrl) {
    const port = env.PORT || "3000";
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error("PORT must be an integer from 1 to 65535, or specify --base-url");
    }
    baseUrl = `http://127.0.0.1:${port}`;
  }
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("--base-url must be an HTTP(S) URL without embedded credentials");
  }
  return new URL("/api/chat", url).href;
}

export function evaluationError(error) {
  const errorCode = error.cause?.code || (typeof error.code === "string" ? error.code : error.name) || "Error";
  return { error: `${error.message} (${errorCode})`, errorCode };
}

export async function waitForChatApi(endpoint, { timeoutMs = 30000, pollIntervalMs = 1000, fetchImpl = fetch } = {}) {
  const start = performance.now();
  let attempts = 0;
  let lastError;
  do {
    attempts += 1;
    let retry = true;
    try {
      // Invalid input exercises the chat route without retrieval, inference or cache warming.
      const response = await fetchImpl(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: null }), redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(3000, timeoutMs - (performance.now() - start))))),
      });
      retry = response.status >= 500 || response.status === 429;
      if (response.status === 400) {
        const body = await response.json();
        if (body.error === validateChatQuestion(null).error && response.headers.get("x-request-id")) {
          return { status: "ready", attempts, durationMs: Math.round(performance.now() - start) };
        }
      } else {
        await response.body?.cancel();
      }
      throw new Error(`HTTP ${response.status}: expected the chat API validation response`);
    } catch (error) {
      lastError = error;
      if (!retry) break;
    }
    const remaining = timeoutMs - (performance.now() - start);
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  } while (performance.now() - start < timeoutMs);

  const error = new Error(`Chat API is not ready at ${endpoint}: ${evaluationError(lastError).error}`, { cause: lastError });
  error.preflight = { status: "failed", attempts, durationMs: Math.round(performance.now() - start), ...evaluationError(lastError) };
  throw error;
}

export function evaluateOutcome(result, { maxDurationMs = 30000, maxFirstContentMs = 10000 } = {}) {
  const latencyErrors = [];
  if (result.durationMs > maxDurationMs) latencyErrors.push(`Total latency exceeds ${maxDurationMs}ms`);
  if (result.firstTokenMs > maxFirstContentMs) latencyErrors.push(`First content exceeds ${maxFirstContentMs}ms`);
  const outcome = result.errors?.length ? "failed" : result.validationFallback ? "degraded" : "checks_passed";
  return { outcome, latencyErrors, accepted: outcome === "checks_passed" && latencyErrors.length === 0 };
}

export function summarizeEvaluation(results) {
  const times = results.filter((r) => Number.isFinite(r.durationMs)).map((r) => r.durationMs).sort((a, b) => a - b);
  const percentile = (fraction) => times[Math.max(0, Math.ceil(times.length * fraction) - 1)] ?? null;
  return { total: results.length, checksPassed: results.filter((r) => !r.errors.length).length,
    accepted: results.filter((r) => r.accepted).length, degraded: results.filter((r) => r.outcome === "degraded").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    cached: results.filter((r) => r.cached).length,
    slow: results.filter((r) => r.latencyErrors.length).length,
    requiresHumanReview: results.filter((r) => r.requiresHumanReview).length,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

async function main() {
const { values } = parseArgs({ options: {
  "base-url": { type: "string" },
  "ready-timeout-ms": { type: "string", default: "30000" },
  models: { type: "boolean", default: false },
  only: { type: "string" },
  timeout: { type: "string", default: "330000" },
  "max-duration-ms": { type: "string", default: "30000" },
  "max-first-content-ms": { type: "string", default: "10000" },
} });
for (const key of ["timeout", "ready-timeout-ms", "max-duration-ms", "max-first-content-ms"]) {
  if (!Number.isFinite(Number(values[key])) || Number(values[key]) <= 0) throw new Error(`--${key} must be a positive number`);
}
const thresholds = { maxDurationMs: Number(values["max-duration-ms"]), maxFirstContentMs: Number(values["max-first-content-ms"]) };
const endpoint = resolveEvaluationEndpoint(values["base-url"]);
await mkdir("logs", { recursive: true });
const path = `logs/chat-evaluation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
console.log(`Chat API: ${endpoint}`);
console.log(`Waiting up to ${values["ready-timeout-ms"]}ms for the chat route before running questions...`);
let preflight;
try {
  preflight = await waitForChatApi(endpoint, { timeoutMs: Number(values["ready-timeout-ms"]) });
} catch (error) {
  await writeFile(path, JSON.stringify({ complete: false, aborted: true, stage: "preflight", at: new Date().toISOString(),
    endpoint, thresholds, preflight: error.preflight, results: [] }, null, 2));
  console.error(error.message);
  console.error("No chatbot questions were run. Check PORT in .env.local, the --base-url override, and pm2 logs rec-expo-chatbot --lines 60 --nostream.");
  console.log(`Report: ${path}`);
  process.exitCode = 1;
  return;
}
console.log(`Chat API ready after ${preflight.durationMs}ms (${preflight.attempts} probe(s)).`);
const snapshot = snapshotToRuntimeData(await readGeneratedRecSnapshot());
const active = snapshot.conference;
const sessionOn = (day) => snapshot.sessions.find((s) => s.day === day)?.title?.trim();
const sponsor = snapshot.sponsors[0]?.name;
const past = snapshot.pastConferences.find((b) => b.mediaItems?.length);
const checks = [
  [{ question: "When will the conference take place?", contains: [String(new Date(active.startDate).getUTCFullYear())], excludes: ["will take place at"] }],
  [{ question: "Tell me about the sponsors", contains: [sponsor], excludes: ["Daily focus areas"] }],
  [
    { question: "What happens on Day 3?", contains: [sessionOn(3)] },
    { question: "what of day 2?", contains: [sessionOn(2)], excludes: [sessionOn(4)] },
    { question: "who are the speakers?", contains: ["speaker"], excludes: [sessionOn(4)] },
    { question: "ohh... thank you", contains: ["welcome"], sources: 0 },
  ],
  [
    { question: "List sessions for all the days", contains: [sessionOn(1), sessionOn(2), sessionOn(3), sessionOn(4)], excludes: ["Plus 1 more"] },
    { question: "only day 4 instead", contains: [sessionOn(4)], excludes: [sessionOn(1), sessionOn(2)] },
  ],
  [{ question: "Who are the sponsors? And on which date is day 2?", contains: [sponsor, "Day 2"], excludes: ["Daily focus areas"] }],
  [{ question: "thanks, when is lunch?", contains: ["Lunch"], excludes: ["Tea Break"] }],
];
if (past) checks.push([
  { question: `Show official photos from REC${String(past.conference.year).slice(2)}`, contains: [past.mediaItems[0].title] },
  { question: "ohh... thank you", contains: ["welcome"], sources: 0 },
  { question: "and their reports?", contains: [String(past.conference.year)], excludes: [active.theme] },
  { question: "What about the current sponsors?", contains: [sponsor], excludes: ["Published reports"] },
]);
if (values.models) checks.push(
  [{ question: "Compare the technology and investment sessions for a first-time visitor. Explain the trade-offs, without inventing speakers.", contains: ["investment"], minSessionTitles: 2, modelReview: true }],
  [{ question: "Who are the sponsors? And how should a small business owner evaluate the opportunities discussed at the conference?", contains: [sponsor], evaluationAdvice: true, modelReview: true }],
  [{ question: "Which sessions are about hydrogen, and is their technical depth published?", rejectBlanketAbsence: true, modelReview: true }],
);

async function ask(question, history, stream) {
  const start = performance.now();
  let requestId = null;
  try {
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history, stream }), signal: AbortSignal.timeout(Number(values.timeout)),
  });
  requestId = response.headers.get("x-request-id");
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  if (!stream) return { ...await response.json(), requestId, durationMs: Math.round(performance.now() - start), firstTokenMs: null };
  let answer = "", sources = [], buffer = "", firstTokenMs = null, done = false, validationFallback = false, cached = false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const event of events) {
      const kind = event.match(/^event: (.+)/m)?.[1];
      const data = JSON.parse(event.match(/^data: (.+)/m)?.[1] || "null");
      if (kind === "error") return { answer, sources: [], error: data.error, requestId, durationMs: Math.round(performance.now() - start), firstTokenMs };
      if (kind === "sources") sources = data;
      if (kind === "token") { answer += data; firstTokenMs ??= Math.round(performance.now() - start); }
      if (kind === "done") { done = true; validationFallback = data.validationFallback === true; cached = data.cached === true; }
    }
  }
  if (!done) throw new Error("SSE ended without a done event");
  return { answer, sources, requestId, validationFallback, cached, durationMs: Math.round(performance.now() - start), firstTokenMs };
  } catch (error) {
    return { answer, sources: [], ...evaluationError(error), requestId, durationMs: Math.round(performance.now() - start), firstTokenMs };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  } catch (error) {
    return { answer: "", sources: [], ...evaluationError(error), requestId, durationMs: Math.round(performance.now() - start), firstTokenMs: null };
  }
}

const results = [];
const selected = checks.filter((scenario) => !values.only || scenario.some((check) => check.question.toLowerCase().includes(values.only.toLowerCase())));
if (!selected.length) throw new Error("No evaluation scenarios match --only");
for (const scenario of selected) {
  const history = [];
  for (const check of scenario) {
    const stream = results.length % 2 === 0;
    try {
      const result = await ask(check.question, history, stream);
      const errors = result.error ? [result.error] : [];
      if (!result.error) {
      for (const text of check.contains || []) if (text && !result.answer.toLowerCase().includes(text.toLowerCase())) errors.push(`Missing: ${text}`);
      for (const text of check.excludes || []) if (text && result.answer.toLowerCase().includes(text.toLowerCase())) errors.push(`Unexpected: ${text}`);
      if (check.minSessionTitles) {
        const canonical = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
        const answerText = canonical(result.answer);
        const titles = [...new Set(snapshot.sessions.map((s) => canonical(s.title)))];
        if (titles.filter((title) => title && answerText.includes(title)).length < check.minSessionTitles) errors.push("Comparison lacks enough exact published session titles");
      }
      if (check.rejectBlanketAbsence && /\b(there are no|does not have any|no sessions|none of the sessions)\b/i.test(result.answer) && !/\b(provided|supplied|could not find|could not confirm)\b/i.test(result.answer)) errors.push("Unqualified absence claim needs evidence review");
      if (check.evaluationAdvice) {
        const criteria = [/\b(costs?|budget|cash flow|payback)\b/i, /\b(customer|market|demand|fit)\b/i, /\b(risks?|terms|verify|evidence|compare|due diligence)\b/i];
        if (criteria.filter((pattern) => pattern.test(result.answer)).length < 2) errors.push("Missing practical evaluation criteria; recommending sessions alone does not answer how to evaluate opportunities");
      }
      if (check.sources !== undefined && result.sources.length !== check.sources) errors.push("Unexpected sources");
      if (!result.answer.trim()) errors.push("Empty answer");
      }
      const outcome = evaluateOutcome({ ...result, errors }, thresholds);
      results.push({ question: check.question, stream, ...result, errors, ...outcome, requiresHumanReview: check.modelReview || false });
      if (!result.error) history.push({ role: "user", content: check.question }, { role: "assistant", content: result.answer });
      console.log(`${outcome.outcome.toUpperCase()}${outcome.latencyErrors.length ? " / SLOW" : ""} ${result.durationMs}ms ${check.question}${errors.length ? `: ${errors.join("; ")}` : ""}`);
    } catch (error) {
      const result = { question: check.question, stream, errors: [error.message], requiresHumanReview: check.modelReview || false };
      results.push({ ...result, ...evaluateOutcome(result, thresholds) });
      console.log(`FAIL ${check.question}: ${error.message}`);
    }
    await writeFile(path, JSON.stringify({ complete: false, endpoint, preflight, thresholds, results }, null, 2));
  }
}
const summary = { ...summarizeEvaluation(results), modelsIncluded: values.models };
await writeFile(path, JSON.stringify({ complete: true, at: new Date().toISOString(), endpoint, preflight, thresholds, summary, results }, null, 2));
console.log(JSON.stringify(summary));
console.log(`Report: ${path}`);
if (summary.accepted !== summary.total) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
