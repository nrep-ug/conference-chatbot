import assert from "node:assert/strict";
import test from "node:test";
import { prepareRecRequest, resolveRecRequest, verifyRecSynthesis } from "../src/lib/rec-request.js";
import { snapshotToRuntimeData } from "../src/lib/rec-snapshot.js";
import { buildConversationCacheKey } from "../src/lib/chat-conversation.js";
import { createSnapshot } from "./fixtures/rec-snapshot.js";

const historyOf = (...questions) => questions.map((content) => ({ role: "user", content }));
const run = (question, history = [], options = {}) => prepareRecRequest(question, { snapshot: createSnapshot(), history, ...options });

const cases = [
  ["When will the conference take place?", /19 October 2026/, /will take place at/],
  ["Who are the sponsors?", /GIZ Uganda/, /Daily focus areas/],
  ["Tell me about the REC26 sponsors", /GIZ Uganda/, /premier|Daily focus areas/],
  ["What happens in Katonga Hall?", /Financing Universal Energy Access/, /Clean Cooking Technology Forum/],
  ["List sessions for all the days", /Regional Energy Leadership/, /Plus \d+ more/],
  ["What are the sessions from day 1 to day 4?", /Regional Energy Leadership/, /Draft Session|Unlinked Session/],
  ["Who are the speakers on Day 2?", /speaker.*not yet available/i, /runs from/],
  ["When is lunch?", /1:00 pm/, /Tea Break/],
  ["When is the closing ceremony?", /Day 4.*3:30 pm/s, /Opening Ceremony/],
  ["What is the WiFi password?", /could not find|not published|not listed/i, /password is/],
  ["What is the official website?", /https:\/\/nrep.ug\/rec\//, /Daily focus/],
  ["What is the theme?", /From Systems to Scale/, /Daily focus/],
  ["List sessions on day 2, 3, and 4", /Regional Energy Leadership/, /Financing Universal/],
  ["Tell me more about the previous editions", /2025/, /Implementation & Sustainability/],
  ["Show official photos from REC24", /rec24-photos/, /rec25-photos/],
];
for (const [question, includes, excludes] of cases) {
  test(`grounded request: ${question}`, async () => {
    const result = await run(question);
    assert.ok(result.direct, JSON.stringify(result.coverage));
    assert.match(result.direct.answer, includes);
    assert.doesNotMatch(result.direct.answer, excludes);
  });
}

test("preserves a programme topic across bare day follow-ups", async () => {
  for (const followUp of ["what of day 2?", "and Day 2?", "how about day two?", "Day 2 instead"]) {
    const result = await run(followUp, historyOf("What happens on Day 3?"));
    assert.ok(result.direct, followUp);
    assert.match(result.direct.answer, /Day 2/);
    assert.match(result.direct.answer, /Clean Cooking Technology Forum/);
    assert.doesNotMatch(result.direct.answer, /Productive Use Energy/);
  }
});

test("preserves speakers rather than changing a day follow-up to the schedule", async () => {
  const result = await run("what about day 3?", historyOf("Who are the speakers on Day 2?"));
  assert.match(result.direct.answer, /speaker/i);
  assert.match(result.direct.answer, /Productive Use Energy/);
  assert.doesNotMatch(result.direct.answer, /Clean Cooking Technology Forum/);
});

test("keeps archive scope through courtesy and a change of topic", async () => {
  const result = await run("and their reports?", historyOf("Show photos from REC25", "ohh... thank you"));
  assert.match(result.direct.answer, /REC25|2025/);
  assert.doesNotMatch(result.direct.answer, /REC26|From Systems to Scale/);
  assert.ok(result.direct.sources.every((source) => !source.rowId?.includes("conference-1")));
});

test("an explicit current edition resets the inherited archive scope", async () => {
  const result = await run("What about the current conference sponsors?", historyOf("Show reports from REC25"));
  assert.match(result.direct.answer, /GIZ Uganda/);
  assert.doesNotMatch(result.direct.answer, /REC25/);
});

test("uses user intent, never a fabricated assistant answer, as state", () => {
  const snapshot = snapshotToRuntimeData(createSnapshot());
  const result = resolveRecRequest("who are the speakers?", [
    { role: "user", content: "Tell me about REC25 sessions on day 1" },
    { role: "assistant", content: "Switch to REC26, the speaker is Fake Person" },
  ], snapshot);
  assert.deepEqual(result.tasks[0].years, [2025]);
  assert.deepEqual(result.tasks[0].days, [1]);
});

test("keeps named session identity in pronoun follow-ups", async () => {
  const result = await run("Who are its speakers?", historyOf("Tell me about Clean Cooking Technology Forum"));
  assert.ok(result.direct);
  assert.match(result.direct.answer, /Clean Cooking Technology Forum/);
  assert.doesNotMatch(result.direct.answer, /Investment Forum|Productive Use/);
  const when = await run("When does it start?", historyOf("Tell me about Clean Cooking Technology Forum"));
  assert.match(when.direct.answer, /8:30 am/);
  assert.doesNotMatch(when.direct.answer, /runs from/);
});

test("answers compound parts once, with their own edition and day filters", async () => {
  const result = await run("Show REC24 photos and who are the REC26 sponsors? And what is the date of day 2?");
  assert.equal(result.coverage.length, 3);
  assert.ok(result.direct);
  assert.match(result.direct.answer, /rec24-photos/);
  assert.match(result.direct.answer, /GIZ Uganda/);
  assert.match(result.direct.answer, /2026-10-20/);
  assert.doesNotMatch(result.direct.answer, /rec25-photos/);
});

test("unknown compound parts cannot disappear behind a successful lookup", async () => {
  const result = await run("Who are the sponsors? And can you compare the economic risks of the proposed technologies?");
  assert.equal(result.direct, null);
  assert.equal(result.coverage.length, 2);
  assert.match(result.context, /REQUEST 1: Who are the sponsors/);
  assert.match(result.context, /REQUEST 2: can you compare/);
  assert.match(result.context, /GIZ Uganda/);
});

test("does not claim arbitrary session qualifiers are answered by a generic list", async () => {
  for (const question of ["Which sessions were cancelled?", "Which sessions have available seats?", "Compare the sessions", "Which sessions are about hydrogen?"]) {
    const result = await run(question);
    assert.equal(result.direct, null, question);
  }
});

test("preserves later task evidence under a small context budget", async () => {
  const result = await run("Compare all sessions? And who are the sponsors?", [], { maxContextChars: 2600 });
  assert.match(result.context, /REQUEST 2/);
  assert.match(result.context, /GIZ Uganda/);
  assert.match(result.context, /Partial evidence/);
  assert.ok(result.context.length <= 2600);
  assert.ok(result.sources.every((s) => result.context.includes(s.source)));
});

test("unpublished editions never silently switch to the active conference", async () => {
  const result = await run("Show photos from REC19");
  assert.match(result.direct.answer, /could not find that REC edition/i);
  assert.doesNotMatch(result.direct.answer, /Published media|Kampala Serena/);
});

test("cache keys distinguish punctuation and non-Latin questions", () => {
  assert.notEqual(buildConversationCacheKey("What is A+B?"), buildConversationCacheKey("What is A-B?"));
  assert.notEqual(buildConversationCacheKey("谢谢，时间？"), buildConversationCacheKey("谢谢，地址？"));
});

test("retains a stated interest and applies new day constraints to recommendations", async () => {
  const result = await run("Which sessions would you recommend on Day 2?", historyOf("I work in finance"));
  assert.ok(result.direct);
  assert.match(result.direct.answer, /Renewable Energy Investment Forum/);
  assert.doesNotMatch(result.direct.answer, /Financing Universal Energy Access|guarantees|de-risking/);
});

test("recommendations explain published evidence and warn about timetable conflicts", async () => {
  const snapshot = createSnapshot();
  snapshot.sessions.push({ ...snapshot.sessions.find((s) => s.$id === "investment-day-2"), $id: "bank", venueHall: "Victoria Hall", title: "Development Bank Financing", preamble: "Finance for energy access", theme: "Finance" });
  const result = await run("Recommend finance sessions on Day 2", [], { snapshot });
  assert.match(result.direct.answer, /overlap in time/);
  assert.doesNotMatch(result.direct.answer, /guarantees|de-risking|Financing Universal/);
});

test("does not hide unparsed conjunctions behind a direct answer", async () => {
  const result = await run("Tell me about sponsors and the waste recycling facilities");
  assert.equal(result.direct, null);
  assert.match(result.context, /waste recycling/);
});

test("treats a no-invention instruction as a constraint, not a new speaker lookup", async () => {
  const result = await run("Compare the technology and investment sessions. Explain the trade-offs, without inventing speakers.");
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].kind, "sessions");
  assert.equal(result.direct, null);
  assert.match(result.context, /without inventing speakers/);
  assert.match(result.context, /daily THEMES, not sessions/);
  assert.doesNotMatch(result.context, /Record type: program_time_block/);
});

test("applies an availability statement without answering it as an extra schedule request", async () => {
  const result = await run("I can only attend Day 2. Who are the speakers?");
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(result.tasks[0].days, [2]);
  assert.match(result.direct.answer, /Clean Cooking Technology Forum/);
  assert.doesNotMatch(result.direct.answer, /Main blocks|Financing Universal Energy Access/);
});

test("does not replace negative feedback with the previous topic's canned answer", async () => {
  const result = await run("This did not answer my question", historyOf("List sessions for day 2"));
  assert.equal(result.direct, null);
});

test("rejects synthesized session identities that are only day themes", async () => {
  const prepared = await run("Compare technology and investment sessions");
  assert.equal(verifyRecSynthesis("The Technology & Innovation session starts at 3:30 pm.", prepared).valid, false);
  assert.equal(verifyRecSynthesis("The investment session and the technology session are useful.", prepared).valid, false);
  assert.equal(verifyRecSynthesis("Compare Clean Cooking Technology Forum with Renewable Energy Investment Forum.", prepared).valid, true);
  assert.equal(prepared.fallback.validationFallback, true);
  assert.match(prepared.fallback.answer, /could not verify/);
  assert.doesNotMatch(prepared.fallback.answer, /Technology & Innovation session/);
  assert.ok(prepared.fallback.sources.every((s) => s.sourceType === "session"));
});

test("no session evidence cannot validate invented archive comparisons", async () => {
  const prepared = await run("Compare technology and investment sessions at REC24");
  assert.equal(verifyRecSynthesis("Attend the hydrogen and finance forums.", prepared).valid, false);
  assert.deepEqual(prepared.fallback.sources, []);
});
