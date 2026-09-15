import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("admin session/status reads neither rewrite the account store nor revive expired sessions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rec-auth-read-"));
  const file = path.join(dir, "data", "admin", "admin-users.json");
  const secret = "test-only-secret",
    token = "test-session-token";
  mkdirSync(path.dirname(file), { recursive: true });
  const seed = JSON.stringify({
    marker: "Reads must preserve this file exactly.",
    version: 1,
    users: [
      {
        email: "qa@example.invalid",
        username: "QA",
        passwordHash: "hash",
        passwordSalt: "salt",
      },
    ],
    sessions: [
      {
        email: "qa@example.invalid",
        tokenHash: createHmac("sha256", secret).update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      {
        email: "qa@example.invalid",
        tokenHash: createHmac("sha256", secret).update("expired").digest("hex"),
        expiresAt: "2020-01-01T00:00:00Z",
      },
    ],
  });
  writeFileSync(file, seed);
  const moduleUrl = new URL("../src/lib/admin-auth.js", import.meta.url).href;
  const script =
    "const a=await import(" +
    JSON.stringify(moduleUrl) +
    '); const reads=[]; for(let i=0;i<12;i++){reads.push(a.getAdminAuthState(),a.getAdminSession("test-session-token"));} const values=await Promise.all(reads); if(values[1]?.email!=="qa@example.invalid" || await a.getAdminSession("expired")!==null) throw new Error("Invalid session result");';
  try {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: dir,
        env: {
          ...process.env,
          ADMIN_AUTH_SECRET: secret,
          ADMIN_AUTH_FILE: "admin-users.json",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(file, "utf8"), seed);
  } finally {
    assert.equal(path.dirname(dir), tmpdir());
    rmSync(dir, { recursive: true });
  }
});

test("verification attempts are bounded and an unsent code can be invalidated", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rec-auth-code-"));
  const file = path.join(dir, "data", "admin", "admin-users.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    version: 1,
    users: [{
      email: "qa@example.invalid",
      username: "QA",
      passwordHash: "hash",
      passwordSalt: "salt",
      role: "owner",
    }],
    loginCodes: [],
    sessions: [],
  }));
  const moduleUrl = new URL("../src/lib/admin-auth.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const auth = await import(${JSON.stringify(moduleUrl)});
    const email = "qa@example.invalid";
    const code = await auth.createAdminLoginCode(email);
    assert.equal(code.mode, "login");
    for (let attempt = 0; attempt < 5; attempt++)
      await assert.rejects(auth.loginAdmin({ email, code: "wrong-code", clientPasswordHash: "a".repeat(64) }), /verification code/i);
    assert.equal(JSON.parse(readFileSync(${JSON.stringify(file)}, "utf8")).loginCodes[0].failedAttempts, 5);
    await assert.rejects(auth.createAdminLoginCode(email), /too many verification attempts/i);
    assert.equal(await auth.invalidateAdminLoginCode(email, "wrong-code"), false);
    assert.equal(await auth.invalidateAdminLoginCode(email, code.code), true);
    const replacement = await auth.createAdminLoginCode(email);
    assert.equal(replacement.reused, false);
    for (let attempt = 0; attempt < 5; attempt++)
      await assert.rejects(auth.loginAdmin({ email, code: replacement.code, clientPasswordHash: "a".repeat(64) }), /invalid admin credentials/i);
    assert.equal(JSON.parse(readFileSync(${JSON.stringify(file)}, "utf8")).loginCodes[0].failedAttempts, 5);
    await assert.rejects(auth.loginAdmin({ email, code: replacement.code, clientPasswordHash: "a".repeat(64) }), /verification code/i);
    assert.equal(JSON.parse(readFileSync(${JSON.stringify(file)}, "utf8")).sessions.length, 0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ADMIN_AUTH_SECRET: "isolated-code-test-secret", ADMIN_AUTH_FILE: "admin-users.json" },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    assert.equal(path.dirname(dir), tmpdir());
    rmSync(dir, { recursive: true });
  }
});
