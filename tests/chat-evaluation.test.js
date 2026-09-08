import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOutcome, summarizeEvaluation, evaluationError } from "../scripts/evaluate-chat.js";

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
