import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class ApiError extends Error {
  constructor(status, code, message, retryAfter = 0) {
    super(message);
    Object.assign(this, { status, code, retryAfter });
  }
}

export function apiInteger(name, fallback, max = 1000000) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`Invalid ${name} configuration.`);
  }
  return number;
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const iso = (time) => new Date(time).toISOString();
const dayOf = (time) => iso(time).slice(0, 10);

function validateSettings(input, previous = {}) {
  const allowed = [
    "name",
    "description",
    "enabled",
    "requestsPerMinute",
    "requestsPerDay",
    "maxConcurrent",
    "expiresAt",
  ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  ) {
    throw new ApiError(
      400,
      "invalid_settings",
      "Unrecognized integration settings.",
    );
  }
  const merged = {
    name: "",
    description: "",
    enabled: true,
    requestsPerMinute: 20,
    requestsPerDay: 1000,
    maxConcurrent: 1,
    ...previous,
    ...input,
  };
  if (
    typeof merged.name !== "string" ||
    merged.name.trim().length < 2 ||
    merged.name.trim().length > 80
  ) {
    throw new ApiError(
      400,
      "invalid_settings",
      "Name must contain 2 to 80 characters.",
    );
  }
  if (
    typeof merged.description !== "string" ||
    merged.description.length > 300 ||
    typeof merged.enabled !== "boolean"
  ) {
    throw new ApiError(
      400,
      "invalid_settings",
      "Check the description and enabled setting.",
    );
  }
  for (const [key, max] of [
    ["requestsPerMinute", 600],
    ["requestsPerDay", 100000],
    ["maxConcurrent", 10],
  ]) {
    if (
      !Number.isSafeInteger(merged[key]) ||
      merged[key] < 1 ||
      merged[key] > max
    ) {
      throw new ApiError(
        400,
        "invalid_settings",
        `${key} must be an integer from 1 to ${max}.`,
      );
    }
  }
  if (
    "expiresAt" in input &&
    (!Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= Date.now() ||
      Date.parse(input.expiresAt) > Date.now() + 366 * 86400000)
  ) {
    throw new ApiError(
      400,
      "invalid_settings",
      "Key expiry must be in the future and within one year.",
    );
  }
  return {
    name: merged.name.trim(),
    description: merged.description.trim(),
    enabled: merged.enabled,
    requestsPerMinute: merged.requestsPerMinute,
    requestsPerDay: merged.requestsPerDay,
    maxConcurrent: merged.maxConcurrent,
    expiresAt: merged.expiresAt || iso(Date.now() + 90 * 86400000),
  };
}

// One SQLite file on local disk coordinates both PM2 workers. Never hold a
// transaction open while waiting for network I/O or model inference.
export class IntegrationStore {
  constructor(file) {
    if (file !== ":memory:")
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY, settings TEXT NOT NULL,
        key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS usage (owner TEXT NOT NULL, day TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0,
        degraded INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, last_used TEXT,
        PRIMARY KEY(owner, day));
      CREATE TABLE IF NOT EXISTS windows (owner TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, day TEXT NOT NULL,
        started INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, integration_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lease_owner ON leases(owner);
      CREATE INDEX IF NOT EXISTS lease_expiry ON leases(expires);
      CREATE INDEX IF NOT EXISTS usage_day ON usage(day);
      CREATE INDEX IF NOT EXISTS window_minute ON windows(minute);`);
    if (file !== ":memory:") chmodSync(file, 0o600);
  }

  close() {
    this.db.close();
  }
  transaction(run) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  row(id) {
    const row = this.db
      .prepare("SELECT * FROM integrations WHERE id=?")
      .get(id);
    if (!row) throw new ApiError(404, "not_found", "Integration not found.");
    return row;
  }
  publicRow(row) {
    return {
      id: row.id,
      ...JSON.parse(row.settings),
      scope: "rec:public:chat",
      keyPrefix: row.key_prefix,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at,
    };
  }
  audit(actor, action, id) {
    this.db
      .prepare(
        "INSERT INTO audit(at,actor,action,integration_id) VALUES(?,?,?,?)",
      )
      .run(iso(Date.now()), actor, action, id);
    this.db.exec(
      "DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 500)",
    );
  }
  list(now = Date.now()) {
    const integrations = this.db
      .prepare("SELECT * FROM integrations ORDER BY created_at DESC, id")
      .all()
      .map((row) => ({
        ...this.publicRow(row),
        usage: this.db
          .prepare("SELECT * FROM usage WHERE owner=? AND day=?")
          .get(row.id, dayOf(now)) || {
          admitted: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          degraded: 0,
          duration_ms: 0,
        },
        activeRequests: this.db
          .prepare(
            "SELECT count(*) AS count FROM leases WHERE owner=? AND expires>?",
          )
          .get(row.id, now).count,
      }));
    return {
      integrations,
      audit: this.db
        .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 30")
        .all(),
      usageDay: dayOf(now),
    };
  }
  create(input, actor) {
    const settings = validateSettings(input);
    return this.transaction(() => {
      if (
        this.db.prepare("SELECT count(*) AS count FROM integrations").get()
          .count >= 200
      ) {
        throw new ApiError(
          409,
          "integration_limit",
          "The registry is limited to 200 integrations.",
        );
      }
      const id = randomBytes(12).toString("hex");
      const key = `rec_${id}_${randomBytes(32).toString("base64url")}`;
      const time = iso(Date.now());
      this.db
        .prepare(
          "INSERT INTO integrations(id,settings,key_hash,key_prefix,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          JSON.stringify(settings),
          digest(key),
          `rec_${id}`,
          time,
          time,
        );
      this.audit(actor, "created", id);
      return { integration: this.publicRow(this.row(id)), key };
    });
  }
  update(id, input, actor, version) {
    return this.transaction(() => {
      const row = this.row(id);
      this.checkVersion(row, version);
      if (row.revoked_at)
        throw new ApiError(
          409,
          "revoked",
          "Revoked integrations cannot be changed.",
        );
      const settings = validateSettings(input, JSON.parse(row.settings));
      this.db
        .prepare(
          "UPDATE integrations SET settings=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(settings), iso(Date.now()), id);
      this.audit(actor, "updated", id);
      return { integration: this.publicRow(this.row(id)) };
    });
  }
  checkVersion(row, version) {
    if (row.version !== version)
      throw new ApiError(
        409,
        "version_conflict",
        "This integration changed. Refresh before saving.",
      );
  }
  rotate(id, actor, version) {
    return this.transaction(() => {
      const row = this.row(id);
      this.checkVersion(row, version);
      if (row.revoked_at)
        throw new ApiError(
          409,
          "revoked",
          "Create a new integration to replace a revoked key.",
        );
      const key = `rec_${id}_${randomBytes(32).toString("base64url")}`;
      const settings = {
        ...JSON.parse(row.settings),
        expiresAt: iso(Date.now() + 90 * 86400000),
      };
      this.db
        .prepare(
          "UPDATE integrations SET settings=?,key_hash=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(settings), digest(key), iso(Date.now()), id);
      this.audit(actor, "key_rotated", id);
      return { integration: this.publicRow(this.row(id)), key };
    });
  }
  revoke(id, actor, version) {
    return this.transaction(() => {
      const row = this.row(id);
      this.checkVersion(row, version);
      const time = iso(Date.now());
      this.db
        .prepare(
          "UPDATE integrations SET revoked_at=?,key_hash='',version=version+1,updated_at=? WHERE id=?",
        )
        .run(time, time, id);
      this.audit(actor, "revoked", id);
      return { integration: this.publicRow(this.row(id)) };
    });
  }
  authenticate(key, now = Date.now()) {
    const match = /^rec_([a-f0-9]{24})_[A-Za-z0-9_-]{43}$/.exec(key || "");
    const row = match
      ? this.db.prepare("SELECT * FROM integrations WHERE id=?").get(match[1])
      : null;
    const expected = Buffer.from(row?.key_hash || "0".repeat(64), "hex");
    const valid = timingSafeEqual(
      expected,
      Buffer.from(digest(String(key || "")), "hex"),
    );
    if (!row || !valid || row.revoked_at)
      throw new ApiError(
        401,
        "invalid_api_key",
        "A valid Bearer API key is required.",
      );
    const integration = this.publicRow(row);
    if (!integration.enabled || Date.parse(integration.expiresAt) <= now) {
      throw new ApiError(
        403,
        "integration_unavailable",
        "This integration is disabled or its key has expired.",
      );
    }
    return integration;
  }
  admit({
    key,
    publicIdentity = "anonymous",
    requestId = randomUUID(),
    now = Date.now(),
    timeoutMs = 180000,
    globalMax = 2,
    publicMinute = 20,
    publicDay = 500,
  }) {
    return this.transaction(() => {
      // Recheck authorization within the admission transaction, including revocation.
      const integration = key ? this.authenticate(key, now) : null;
      const owner = integration?.id || `public:${digest(publicIdentity)}`;
      const limits = integration || {
        requestsPerMinute: publicMinute,
        requestsPerDay: publicDay,
        maxConcurrent: 1,
      };
      const day = dayOf(now),
        minute = Math.floor(now / 60000);
      const expired = this.db
        .prepare("SELECT * FROM leases WHERE expires<=?")
        .all(now);
      for (const lease of expired) {
        this.db
          .prepare(
            "UPDATE usage SET failed=failed+1,duration_ms=duration_ms+? WHERE owner=? AND day=?",
          )
          .run(lease.expires - lease.started, lease.owner, lease.day);
      }
      this.db.prepare("DELETE FROM leases WHERE expires<=?").run(now);
      this.db.prepare("DELETE FROM windows WHERE minute<?").run(minute - 1);
      this.db
        .prepare("DELETE FROM usage WHERE day<?")
        .run(dayOf(now - 30 * 86400000));
      const window = this.db
        .prepare("SELECT * FROM windows WHERE owner=?")
        .get(owner);
      const count = window?.minute === minute ? window.count : 0;
      const usage =
        this.db
          .prepare("SELECT admitted FROM usage WHERE owner=? AND day=?")
          .get(owner, day)?.admitted || 0;
      if (count >= limits.requestsPerMinute)
        throw new ApiError(
          429,
          "rate_limit_exceeded",
          "Request limit reached for this minute.",
          Math.ceil((60000 - (now % 60000)) / 1000),
        );
      if (usage >= limits.requestsPerDay)
        throw new ApiError(
          429,
          "daily_quota_exceeded",
          "Daily request quota reached (resets at midnight UTC).",
          Math.ceil((86400000 - (now % 86400000)) / 1000),
        );
      if (
        this.db
          .prepare("SELECT count(*) AS count FROM leases WHERE owner=?")
          .get(owner).count >= limits.maxConcurrent
      ) {
        throw new ApiError(
          429,
          "concurrency_limit",
          "Another request is still running for this integration or public client.",
          5,
        );
      }
      if (
        this.db.prepare("SELECT count(*) AS count FROM leases").get().count >=
        globalMax
      ) {
        throw new ApiError(
          503,
          "capacity_exceeded",
          "The assistant is at capacity. Retry shortly.",
          5,
        );
      }
      this.db
        .prepare(
          "INSERT INTO windows(owner,minute,count) VALUES(?,?,1) ON CONFLICT(owner) DO UPDATE SET minute=excluded.minute,count=?",
        )
        .run(owner, minute, count + 1);
      this.db
        .prepare(
          "INSERT INTO usage(owner,day,admitted,last_used) VALUES(?,?,1,?) ON CONFLICT(owner,day) DO UPDATE SET admitted=admitted+1,last_used=excluded.last_used",
        )
        .run(owner, day, iso(now));
      this.db
        .prepare(
          "INSERT INTO leases(id,owner,day,started,expires) VALUES(?,?,?,?,?)",
        )
        .run(requestId, owner, day, now, now + timeoutMs + 5000);
      return {
        requestId,
        integrationId: integration?.id || null,
        remaining: limits.requestsPerMinute - count - 1,
        limit: limits.requestsPerMinute,
      };
    });
  }
  finish(requestId, outcome = "completed", now = Date.now()) {
    this.transaction(() => {
      const lease = this.db
        .prepare("SELECT * FROM leases WHERE id=?")
        .get(requestId);
      if (!lease) return;
      const field = ["completed", "failed", "cancelled", "degraded"].includes(
        outcome,
      )
        ? outcome
        : "failed";
      this.db
        .prepare(
          `UPDATE usage SET ${field}=${field}+1,duration_ms=duration_ms+? WHERE owner=? AND day=?`,
        )
        .run(Math.max(0, now - lease.started), lease.owner, lease.day);
      this.db.prepare("DELETE FROM leases WHERE id=?").run(requestId);
    });
  }
}

let singleton;
export function getIntegrationStore() {
  // Mutable runtime state must not be bundled into a deployment artifact.
  singleton ||= new IntegrationStore(
    path.resolve(
      /* turbopackIgnore: true */ process.env.CHAT_API_DB_FILE ||
        "data/admin/integrations.sqlite",
    ),
  );
  return singleton;
}
