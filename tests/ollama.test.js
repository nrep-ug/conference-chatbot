import assert from "node:assert/strict";
import test from "node:test";
import { askMistral, askPlanner, streamMistral, getAnswerContextBudget } from "../src/lib/ollama.js";

const input = { question: "Who are the sponsors?", context: "Published sponsors" };
function mockStream(t, packets) {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(packets);
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  })));
}

test("planner requests JSON format without the previous investment example bias", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.format, "json");
    assert.equal(body.stream, true);
    assert.doesNotMatch(body.messages.at(-1).content, /\["investment"\]/);
    return Response.json({ done: true, message: { content: '{"lookup":false}' } });
  });
  assert.equal(await askPlanner({ question: "List sessions", schema: "Public tables" }), '{"lookup":false}');
});

test("stream decoder preserves UTF-8 and handles a final packet without a newline", async (t) => {
  mockStream(t, '{"message":{"content":"Caf\u00e9 "}}\n{"message":{"content":"sessions"},"done":true,"done_reason":"stop"}');
  let tokens = "";
  assert.equal(await streamMistral({ ...input, onToken: (text) => { tokens += text; } }), "Caf\u00e9 sessions");
  assert.equal(tokens, "Caf\u00e9 sessions");
});

for (const [name, packets, expected] of [
  ["truncated transport", '{"message":{"content":"Partial answer"}}\n', /before completion/],
  ["output limit", '{"message":{"content":"Partial"},"done":true,"done_reason":"length"}\n', /output limit/],
  ["upstream error", '{"error":"runner unavailable"}\n', /runner unavailable/],
  ["empty output", '{"done":true,"message":{"content":""}}\n', /complete answer/],
]) {
  test(`does not accept ${name} as a successful model answer`, async (t) => {
    mockStream(t, packets);
    await assert.rejects(streamMistral(input), expected);
  });
}

test("non-streamed token-limited responses also fail instead of being cached", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ done: true, done_reason: "length", message: { content: "Incomplete" } }));
  await assert.rejects(askMistral(input), /output limit/);
});

test("reserves more context space for a longer conversation", () => {
  const short = getAnswerContextBudget("Compare sessions");
  const long = getAnswerContextBudget("Compare sessions", [{ role: "user", content: "Previous request ".repeat(60) }]);
  assert.ok(short > long);
  assert.ok(long >= 0);
});

test("output budgets follow the question, not words copied from source descriptions", async (t) => {
  for (const [key, value] of Object.entries({ CHAT_NUM_PREDICT: "360", CHAT_MAX_NUM_PREDICT: "1024" })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const limits = [];
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    const body = JSON.parse(request.body);
    limits.push(body.options.num_predict);
    return Response.json({ done: true, message: { content: "Complete response" } });
  });
  await askMistral({ question: "Compare two sessions", context: "REQUEST 1: Compare sessions\nDescription: explain every technology in depth" });
  await askMistral({ question: "Who are the sponsors and how should I evaluate opportunities?", context: "REQUEST 1: Sponsors\nREQUEST 2: Evaluate opportunities" });
  await askMistral({ question: "Compare all sessions in depth", context: "REQUEST 1: Sessions" });
  assert.deepEqual(limits, [360, 360, 768]);
});

test("reports model stage timings and counts without prompt or answer contents", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ done: true, done_reason: "stop", message: { content: "Published sponsors" },
    load_duration: 1200000000, prompt_eval_duration: 5000000000, eval_duration: 2000000000, total_duration: 8300000000,
    prompt_eval_count: 500, eval_count: 20 }));
  let metrics;
  await askMistral({ ...input, requestId: "test-id", onMetrics: (value) => { metrics = value; } });
  assert.equal(metrics.success, true);
  assert.equal(metrics.requestId, "test-id");
  assert.equal(metrics.loadMs, 1200);
  assert.equal(metrics.promptEvalMs, 5000);
  assert.equal(metrics.generationMs, 2000);
  assert.equal(metrics.generatedPerSecond, 10);
  assert.equal(metrics.promptEvalCount, 500);
  assert.ok(Number.isFinite(metrics.firstContentMs));
  assert.equal(metrics.delivery, "buffered");
  assert.equal(metrics.receivedChars, "Published sponsors".length);
  assert.doesNotMatch(JSON.stringify(metrics), /Who are|Published sponsors/);
});

test("stream failure retains first-content timing without inventing missing final metrics", async (t) => {
  mockStream(t, '{"message":{"content":"Partial"}}\n');
  let metrics;
  await assert.rejects(streamMistral({ ...input, onMetrics: (value) => { metrics = value; } }), /before completion/);
  assert.equal(metrics.success, false);
  assert.ok(Number.isFinite(metrics.firstContentMs));
  assert.equal(metrics.promptEvalMs, null);
  assert.equal(metrics.generationMs, null);
});

test("diagnostic callback failure does not fail an otherwise complete answer", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ done: true, message: { content: "Complete" } }));
  assert.equal(await askMistral({ ...input, onMetrics: () => { throw new Error("observer error"); } }), "Complete");
});

test("buffered answers collect the stream but never emit unvalidated content", async (t) => {
  mockStream(t, '{"message":{"content":"Part one "}}\n{"message":{"content":"and two"},"done":true}\n');
  let emitted = false, metrics;
  const answer = await askMistral({ ...input, onToken: () => { emitted = true; }, onMetrics: (value) => { metrics = value; } });
  assert.equal(answer, "Part one and two");
  assert.equal(emitted, false);
  assert.equal(metrics.delivery, "buffered");
  assert.equal(metrics.receivedChars, answer.length);
});

test("buffered failure records generation progress without accepting a partial answer", async (t) => {
  mockStream(t, '{"message":{"content":"Partial unpublished response"}}\n');
  let metrics;
  await assert.rejects(askMistral({ ...input, onMetrics: (value) => { metrics = value; } }), /before completion/);
  assert.equal(metrics.success, false);
  assert.equal(metrics.receivedChars, 28);
  assert.ok(Number.isFinite(metrics.firstContentMs));
  assert.ok(Number.isFinite(metrics.lastContentMs));
  assert.equal(metrics.evalCount, null);
});

test("model timeout has a distinct reason and cancels the pending request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  let metrics;
  const result = askMistral({ ...input, onMetrics: (value) => { metrics = value; } });
  const check = assert.rejects(result, { name: "TimeoutError" });
  t.mock.timers.tick(Number.parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 120000);
  await check;
  assert.equal(metrics.errorCode, "TimeoutError");
  assert.equal(metrics.receivedChars, 0);
  assert.equal(metrics.firstContentMs, null);
});

test("client cancellation preserves its reason rather than appearing as a model deadline", async (t) => {
  const abort = new AbortController();
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  let metrics;
  const result = askMistral({ ...input, signal: abort.signal, onMetrics: (value) => { metrics = value; } });
  const check = assert.rejects(result, { name: "AbortError" });
  abort.abort();
  await check;
  assert.equal(metrics.errorCode, "AbortError");
});
