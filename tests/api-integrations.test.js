import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { IntegrationStore } from "../src/lib/api-integrations.js";

function fixture(t, settings = {}) {
  const store = new IntegrationStore(":memory:");
  t.after(() => store.close());
  return {
    store,
    ...store.create(
      { name: "Test backend", ...settings },
      "test@example.invalid",
    ),
  };
}
const code = (expected) => (error) => error.code === expected;

test("integration secrets are high-entropy, hashed at rest and never listed or audited", (t) => {
  const { store, key, integration } = fixture(t);
  assert.match(key, /^rec_[a-f0-9]{24}_[\w-]{43}$/);
  assert.equal(store.authenticate(key).scope, "rec:public:chat");
  const row = store.row(integration.id);
  assert.equal(row.key_hash.length, 64);
  assert.ok(!JSON.stringify(row).includes(key));
  assert.ok(!JSON.stringify(store.list()).includes(key));
  assert.equal(store.list().audit[0].action, "created");
  assert.throws(
    () => store.authenticate(key.slice(0, -1) + "!"),
    code("invalid_api_key"),
  );
  assert.throws(
    () => store.authenticate("rec_" + "0".repeat(24) + "_" + "x".repeat(43)),
    code("invalid_api_key"),
  );
});

test("disabled, expired and revoked keys fail closed; rotation invalidates the old key", (t) => {
  const { store, key, integration } = fixture(t);
  const id = integration.id;
  store.update(id, { enabled: false }, "admin", 1);
  assert.throws(() => store.authenticate(key), code("integration_unavailable"));
  store.update(id, { enabled: true }, "admin", 2);
  const rotated = store.rotate(id, "admin", 3);
  assert.throws(() => store.authenticate(key), code("invalid_api_key"));
  assert.equal(store.authenticate(rotated.key).id, id);
  assert.throws(
    () =>
      store.authenticate(
        rotated.key,
        Date.parse(rotated.integration.expiresAt) + 1,
      ),
    code("integration_unavailable"),
  );
  store.revoke(id, "admin", 4);
  assert.throws(() => store.authenticate(rotated.key), code("invalid_api_key"));
  assert.throws(
    () => store.update(id, { enabled: true }, "admin", 5),
    code("revoked"),
  );
});

test("integration configuration rejects invalid limits, unknown scope overrides and stale writes", (t) => {
  const { store, integration } = fixture(t);
  for (const settings of [
    { name: "" },
    { scope: "private" },
    { maxConcurrent: 11 },
    { requestsPerMinute: "20" },
    { requestsPerDay: -1 },
    { enabled: "true" },
    { expiresAt: "yesterday" },
  ]) {
    assert.throws(
      () => store.update(integration.id, settings, "admin", 1),
      code("invalid_settings"),
    );
  }
  store.update(integration.id, { name: "Changed backend" }, "admin", 1);
  assert.throws(
    () => store.update(integration.id, { name: "Overwritten" }, "admin", 1),
    code("version_conflict"),
  );
  assert.equal(store.list().integrations[0].name, "Changed backend");
});

test("minute and UTC daily quotas count admitted attempts including cached answers and failures", (t) => {
  const { store, key } = fixture(t, {
    requestsPerMinute: 2,
    requestsPerDay: 3,
  });
  const now = Date.parse(new Date().toISOString().slice(0, 10) + "T12:00:00Z");
  for (const [index, outcome] of ["completed", "failed"].entries()) {
    store.admit({ key, now, requestId: String(index) });
    store.finish(String(index), outcome, now + 100);
  }
  assert.throws(() => store.admit({ key, now }), code("rate_limit_exceeded"));
  store.admit({ key, now: now + 60000, requestId: "third" });
  store.finish("third", "cancelled", now + 60200);
  assert.throws(
    () => store.admit({ key, now: now + 60000 }),
    code("daily_quota_exceeded"),
  );
  const usage = store.list(now).integrations[0].usage;
  assert.equal(usage.admitted, 3);
  assert.equal(usage.completed, 1);
  assert.equal(usage.failed, 1);
  assert.equal(usage.cancelled, 1);
  assert.equal(usage.duration_ms, 400);
  store.finish("third", "completed", now + 61000);
  assert.equal(store.list(now).integrations[0].usage.completed, 1);
});

test("concurrency is global across public and integration traffic and rechecks revocation at admission", (t) => {
  const { store, key, integration } = fixture(t);
  store.admit({ key, requestId: "first", globalMax: 1 });
  assert.throws(() => store.admit({ key }), code("concurrency_limit"));
  assert.throws(
    () => store.admit({ publicIdentity: "public", globalMax: 1 }),
    code("capacity_exceeded"),
  );
  store.finish("first");
  store.revoke(integration.id, "admin", 1);
  assert.throws(() => store.admit({ key }), code("invalid_api_key"));
  const lease = store.admit({ publicIdentity: "public", globalMax: 1 });
  assert.equal(lease.integrationId, null);
});

test("daily limits reset at midnight UTC, not after a restart or key rotation", (t) => {
  const { store, key, integration } = fixture(t, { requestsPerDay: 1 });
  const before = Date.parse(new Date().toISOString().slice(0, 10) + "T23:59:00Z");
  store.admit({ key, now: before, requestId: "last-today" });
  store.finish("last-today", "completed", before + 100);
  const rotated = store.rotate(integration.id, "admin", 1);
  assert.throws(() => store.admit({ key: rotated.key, now: before + 1000 }), code("daily_quota_exceeded"));
  store.admit({ key: rotated.key, now: before + 61000, requestId: "first-tomorrow" });
  assert.equal(store.list(before + 61000).integrations[0].usage.admitted, 1);
});

test("dead worker leases expire and recover capacity, and live workers release idempotently", (t) => {
  const { store, key } = fixture(t);
  const now = Date.now();
  store.admit({ key, now, timeoutMs: 100, requestId: "dead" });
  store.admit({ key, now: now + 5200, requestId: "live" });
  assert.equal(store.list(now).integrations[0].usage.failed, 1);
  store.finish("live", "degraded", now + 5250);
  assert.equal(store.list(now).integrations[0].usage.degraded, 1);
});

test("two database connections observe credentials, quotas and revocation immediately", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "rec-api-store-"));
  const file = path.join(dir, "integrations.sqlite");
  const one = new IntegrationStore(file),
    two = new IntegrationStore(file);
  t.after(() => {
    one.close();
    two.close();
    assert.equal(path.dirname(dir), tmpdir());
    rmSync(dir, { recursive: true });
  });
  const { key, integration } = one.create({ name: "Shared registry" }, "admin");
  assert.equal(two.authenticate(key).id, integration.id);
  one.admit({ key, requestId: "shared" });
  assert.throws(() => two.admit({ key }), code("concurrency_limit"));
  two.finish("shared");
  one.revoke(integration.id, "admin", 1);
  assert.throws(() => two.authenticate(key), code("invalid_api_key"));
  assert.ok(!readFileSync(file).includes(Buffer.from(key)));
});

test("independent Node workers cannot race past one global admission slot", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "rec-api-workers-"));
  const file = path.join(dir, "integrations.sqlite");
  const store = new IntegrationStore(file);
  const { key } = store.create(
    { name: "Cluster test", maxConcurrent: 10 },
    "admin",
  );
  store.close();
  t.after(() => {
    assert.equal(path.dirname(dir), tmpdir());
    rmSync(dir, { recursive: true });
  });
  const script =
    'import {IntegrationStore} from "./src/lib/api-integrations.js"; const s=new IntegrationStore(process.env.TEST_STORE); try {s.admit({key:process.env.TEST_KEY,globalMax:1});console.log("admitted");} catch(e) {console.log(e.code);} s.close();';
  const workers = [];
  for (let i = 0; i < 4; i++) {
    workers.push(
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", script],
          { env: { ...process.env, TEST_STORE: file, TEST_KEY: key } },
        );
        let result = "";
        child.stdout.on("data", (chunk) => {
          result += chunk;
        });
        child.stderr.resume();
        child.on("error", reject);
        child.on("close", (exit) =>
          exit ? reject(new Error("Worker failed")) : resolve(result.trim()),
        );
      }),
    );
  }
  const results = await Promise.all(workers);
  assert.equal(results.filter((result) => result === "admitted").length, 1);
  assert.equal(
    results.filter((result) => result === "capacity_exceeded").length,
    3,
  );
});
