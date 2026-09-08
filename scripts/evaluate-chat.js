import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { readGeneratedRecSnapshot, snapshotToRuntimeData } from "../src/lib/rec-snapshot.js";

const { values } = parseArgs({ options: {
  "base-url": { type: "string", default: "http://127.0.0.1:3000" },
  models: { type: "boolean", default: false },
  only: { type: "string" },
  timeout: { type: "string", default: "330000" },
} });
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
  [{ question: "Who are the sponsors? And how should a small business owner evaluate the opportunities discussed at the conference?", contains: [sponsor], modelReview: true }],
  [{ question: "Which sessions are about hydrogen, and is their technical depth published?", rejectBlanketAbsence: true, modelReview: true }],
);

async function ask(question, history, stream) {
  const start = performance.now();
  const response = await fetch(new URL("/api/chat", values["base-url"]), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history, stream }), signal: AbortSignal.timeout(Number(values.timeout)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  if (!stream) return { ...await response.json(), durationMs: Math.round(performance.now() - start), firstTokenMs: null };
  let answer = "", sources = [], buffer = "", firstTokenMs = null, done = false, validationFallback = false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const event of events) {
      const kind = event.match(/^event: (.+)/m)?.[1];
      const data = JSON.parse(event.match(/^data: (.+)/m)?.[1] || "null");
      if (kind === "error") return { answer, sources: [], error: data.error, durationMs: Math.round(performance.now() - start), firstTokenMs };
      if (kind === "sources") sources = data;
      if (kind === "token") { answer += data; firstTokenMs ??= Math.round(performance.now() - start); }
      if (kind === "done") { done = true; validationFallback = data.validationFallback === true; }
    }
  }
  if (!done) throw new Error("SSE ended without a done event");
  return { answer, sources, validationFallback, durationMs: Math.round(performance.now() - start), firstTokenMs };
}

const results = [];
await mkdir("logs", { recursive: true });
const path = `logs/chat-evaluation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const selected = checks.filter((scenario) => !values.only || scenario.some((check) => check.question.toLowerCase().includes(values.only.toLowerCase())));
if (!selected.length) throw new Error("No evaluation scenarios match --only");
for (const scenario of selected) {
  const history = [];
  for (const check of scenario) {
    const stream = results.length % 2 === 0;
    try {
      const result = await ask(check.question, history, stream);
      const errors = result.error ? [result.error] : [];
      for (const text of check.contains || []) if (text && !result.answer.toLowerCase().includes(text.toLowerCase())) errors.push(`Missing: ${text}`);
      for (const text of check.excludes || []) if (text && result.answer.toLowerCase().includes(text.toLowerCase())) errors.push(`Unexpected: ${text}`);
      if (check.minSessionTitles) {
        const canonical = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
        const answerText = canonical(result.answer);
        const titles = [...new Set(snapshot.sessions.map((s) => canonical(s.title)))];
        if (titles.filter((title) => title && answerText.includes(title)).length < check.minSessionTitles) errors.push("Comparison lacks enough exact published session titles");
      }
      if (check.rejectBlanketAbsence && /\b(there are no|does not have any|no sessions|none of the sessions)\b/i.test(result.answer) && !/\b(provided|supplied|could not find|could not confirm)\b/i.test(result.answer)) errors.push("Unqualified absence claim needs evidence review");
      if (check.sources !== undefined && result.sources.length !== check.sources) errors.push("Unexpected sources");
      if (!result.answer.trim()) errors.push("Empty answer");
      results.push({ question: check.question, stream, ...result, errors, requiresHumanReview: check.modelReview || false });
      if (!result.error) history.push({ role: "user", content: check.question }, { role: "assistant", content: result.answer });
      console.log(`${errors.length ? "FAIL" : "PASS"} ${result.durationMs}ms ${check.question}${errors.length ? `: ${errors.join("; ")}` : ""}`);
    } catch (error) {
      results.push({ question: check.question, stream, errors: [error.message] });
      console.log(`FAIL ${check.question}: ${error.message}`);
    }
    await writeFile(path, JSON.stringify({ complete: false, results }, null, 2));
  }
}
const times = results.filter((r) => Number.isFinite(r.durationMs)).map((r) => r.durationMs).sort((a, b) => a - b);
const summary = { total: results.length, passed: results.filter((r) => !r.errors.length).length, validationFallbacks: results.filter((r) => r.validationFallback).length, p50Ms: times[Math.floor(times.length * 0.5)] || 0, p95Ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] || 0, modelsIncluded: values.models };
await writeFile(path, JSON.stringify({ complete: true, at: new Date().toISOString(), summary, results }, null, 2));
console.log(JSON.stringify(summary));
console.log(`Report: ${path}`);
if (summary.passed !== summary.total) process.exitCode = 1;
