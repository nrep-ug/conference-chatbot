import assert from "node:assert/strict";
import test from "node:test";
import { validateRecPlan, executeRecPlan } from "../src/lib/rec-planner.js";
import { snapshotToRuntimeData } from "../src/lib/rec-snapshot.js";
import { createSnapshot } from "./fixtures/rec-snapshot.js";

test("rejects invented planner narrowing, private tables, and malformed operations", () => {
  const plan = (filters, table = "sessions") => ({ operations: [{ table, filters, limit: 8 }] });
  assert.equal(validateRecPlan(plan({ keywords: ["investment"] }), "List all sessions"), null);
  assert.equal(validateRecPlan(plan({ day: 2 }), "List all sessions"), null);
  assert.equal(validateRecPlan(plan({ year: 2025 }), "List all sessions"), null);
  assert.equal(validateRecPlan(plan({}, "registrations"), "Who registered?"), null);
  assert.equal(validateRecPlan(plan({}, "__proto__"), "List data"), null);
  assert.equal(validateRecPlan(plan({}, "constructor"), "List data"), null);
  assert.equal(validateRecPlan({ operations: [null] }, "List sessions"), null);
  assert.ok(validateRecPlan(plan({ keywords: ["investment"] }), "Sessions about investment"));
  assert.ok(validateRecPlan(plan(null), "List all sessions"));
});

test("joins daily themes to session search and reports retrieval coverage", () => {
  const snapshot = snapshotToRuntimeData(createSnapshot());
  const plan = validateRecPlan({ operations: [{ table: "sessions", filters: { keywords: ["Technology & Innovation"] }, limit: 12 }] }, "Sessions for Technology & Innovation");
  const result = executeRecPlan(plan, snapshot, 10000);
  assert.equal(result.coverage[0].matched, 2);
  assert.equal(result.coverage[0].complete, true);
  assert.match(result.context, /Clean Cooking Technology Forum/);
  assert.match(result.context, /Renewable Energy Investment Forum/);
});

test("row and context limits cannot masquerade as complete retrievals", () => {
  const plan = validateRecPlan({ operations: [{ table: "sessions", limit: 1 }] }, "List sessions");
  const result = executeRecPlan(plan, snapshotToRuntimeData(createSnapshot()), 2000);
  assert.equal(result.coverage[0].complete, false);
  assert.equal(result.coverage[0].matched, 5);
  assert.match(result.context, /Partial evidence/);
  for (const source of result.sources) assert.ok(result.context.includes(source.source));
});
