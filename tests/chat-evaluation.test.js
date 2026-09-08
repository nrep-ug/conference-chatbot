import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOutcome, summarizeEvaluation, evaluationError, resolveEvaluationEndpoint, waitForChatApi } from "../scripts/evaluate-chat.js";

const readyResponse = () => Response.json({ error: "Please provide a valid question." }, {
  status: 400, headers: { "x-request-id": "readiness-probe" },
});

test("evaluation targets the configured PM2 port unless explicitly overridden", () => {
  assert.equal(resolveEvaluationEndpoint(undefined, { PORT: "3210" }), "http://127.0.0.1:3210/api/chat");
  assert.equal(resolveEvaluationEndpoint(undefined, {}), "http://127.0.0.1:3000/api/chat");
  assert.equal(resolveEvaluationEndpoint("https://chat.example.org", { PORT: "invalid" }), "https://chat.example.org/api/chat");
  for (const port of ["abc", "0", "65536", "3000.5", "-1"]) {
    assert.throws(() => resolveEvaluationEndpoint(undefined, { PORT: port }), /PORT/);
  }
  assert.throws(() => resolveEvaluationEndpoint("file:///tmp/chat"), /HTTP/);
  assert.throws(() => resolveEvaluationEndpoint("https://user:secret@example.org"), /credentials/);
});

test("preflight exercises validation only, without a real question or cache warming", async () => {
  const result = await waitForChatApi("http://localhost:3210/api/chat", { fetchImpl: async (url, options) => {
    assert.equal(url, "http://localhost:3210/api/chat");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { question: null });
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    return readyResponse();
  } });
  assert.equal(result.status, "ready");
  assert.equal(result.attempts, 1);
});

test("preflight waits through refused connections and temporary startup responses", async () => {
  let calls = 0;
  const result = await waitForChatApi("http://localhost:3210/api/chat", { pollIntervalMs: 1, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    if (calls === 2) return new Response("Starting", { status: 503 });
    return readyResponse();
  } });
  assert.equal(result.status, "ready");
  assert.equal(result.attempts, 3);
});

test("unreachable API times out as one setup failure with its endpoint and root cause", async () => {
  await assert.rejects(waitForChatApi("http://localhost:3210/api/chat", {
    timeoutMs: 20, pollIntervalMs: 1, fetchImpl: async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    },
  }), (error) => {
    assert.match(error.message, /localhost:3210\/api\/chat.*ECONNREFUSED/);
    assert.equal(error.preflight.status, "failed");
    assert.equal(error.preflight.errorCode, "ECONNREFUSED");
    assert.ok(error.preflight.attempts >= 1);
    return true;
  });
});

test("unrelated servers, redirects and authorization errors do not pass readiness", async () => {
  for (const status of [200, 301, 401, 403, 404, 405]) {
    await assert.rejects(waitForChatApi("https://chat.example.org/api/chat", {
      fetchImpl: async () => new Response("Not the chat API", { status }),
    }), (error) => {
      assert.equal(error.preflight.attempts, 1);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
  }
});

test("a generic 400 is not mistaken for the chat validation contract", async () => {
  for (const response of [
    Response.json({ error: "Please provide a valid question." }, { status: 400 }),
    Response.json({ error: "Wrong API" }, { status: 400, headers: { "x-request-id": "other" } }),
    new Response("Bad request", { status: 400 }),
  ]) {
    await assert.rejects(waitForChatApi("https://chat.example.org/api/chat", {
      fetchImpl: async () => response,
    }), (error) => error.preflight.attempts === 1);
  }
});

test("preflight applies its deadline to a server that accepts but never responds", async () => {
  await assert.rejects(waitForChatApi("http://localhost:3210/api/chat", {
    timeoutMs: 20, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      // Real sockets keep Node alive; emulate that while AbortSignal's unref'ed timer runs.
      const timer = setTimeout(() => reject(new Error("Deadline not applied")), 1000);
      signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }),
  }), (error) => error.preflight.errorCode === "TimeoutError");
});

test("validation fallback is degraded even if keyword assertions pass", () => {
  const result = evaluateOutcome({ errors: [], validationFallback: true, durationMs: 185932, firstTokenMs: 185931 });
  assert.equal(result.outcome, "degraded");
  assert.equal(result.accepted, false);
  assert.equal(result.latencyErrors.length, 2);
});

test("successful but unusably slow model answers fail latency acceptance", () => {
  const result = evaluateOutcome({ errors: [], durationMs: 285099, firstTokenMs: null });
  assert.equal(result.outcome, "checks_passed");
  assert.equal(result.accepted, false);
  assert.equal(result.latencyErrors.length, 1);
});

test("reports separate failures, degradation, latency and checks passed", () => {
  const inputs = [
    { errors: [], durationMs: 30 },
    { errors: [], durationMs: 186000, validationFallback: true, requiresHumanReview: true },
    { errors: ["Timeout"], durationMs: 300000 },
  ];
  const results = inputs.map((r) => ({ ...r, ...evaluateOutcome(r) }));
  const summary = summarizeEvaluation(results);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.checksPassed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.degraded, 1);
  assert.equal(summary.slow, 2);
  assert.equal(summary.requiresHumanReview, 1);
  assert.equal(summary.p95Ms, 300000);
});

test("transport failures preserve the underlying code", () => {
  const result = evaluationError(new TypeError("fetch failed", { cause: Object.assign(new Error("Headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" }) }));
  assert.equal(result.errorCode, "UND_ERR_HEADERS_TIMEOUT");
  assert.match(result.error, /fetch failed.*UND_ERR_HEADERS_TIMEOUT/);
});
