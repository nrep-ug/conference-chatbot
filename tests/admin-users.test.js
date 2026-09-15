import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

test("owner manages approved accounts while other roles cannot, with isolated setup and revocation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rec-admin-users-"));
  const file = path.join(dir, "data", "admin", "admin-users.json");
  const secret = "isolated-owner-test-secret";
  mkdirSync(path.dirname(file), { recursive: true });
  const users = [
    { email: "owner@example.invalid", username: "Owner", passwordHash: "hash", passwordSalt: "salt", role: "owner" },
    { email: "admin@example.invalid", username: "Admin", passwordHash: "hash", passwordSalt: "salt", role: "admin" },
    { email: "viewer@example.invalid", username: "Viewer", passwordHash: "hash", passwordSalt: "salt", role: "viewer" },
  ];
  const sessions = users.map((user) => ({
    email: user.email,
    tokenHash: createHmac("sha256", secret).update(`${user.role}-token`).digest("hex"),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  }));
  writeFileSync(file, JSON.stringify({ version: 1, users, sessions, loginCodes: [] }));
  const routeUrl = new URL("../src/app/api/admin/users/route.js", import.meta.url).href;
  const authUrl = new URL("../src/lib/admin-auth.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    const { GET, POST } = await import(${JSON.stringify(routeUrl)});
    const auth = await import(${JSON.stringify(authUrl)});
    const url = "http://localhost/api/admin/users";
    const cookie = (role) => "rec_admin_session=" + role + "-token";
    const request = (body, role = "owner", origin = "http://localhost") =>
      new Request(url, { method: "POST", headers: {
        "Content-Type": "application/json", cookie: cookie(role), ...(origin ? { origin } : {}),
      }, body: JSON.stringify(body) });
    assert.equal((await GET(new Request(url))).status, 401);
    assert.equal((await GET(new Request(url, { headers: { cookie: cookie("owner") } }))).status, 200);
    assert.equal((await GET(new Request(url, { headers: { cookie: cookie("admin") } }))).status, 403);
    assert.equal((await GET(new Request(url, { headers: { cookie: cookie("viewer") } }))).status, 403);
    assert.equal((await POST(request({ action: "invite", email: "qa@example.invalid", role: "admin" }, "admin"))).status, 403);
    assert.equal((await POST(request({ action: "invite", email: "qa@example.invalid", role: "admin" }, "viewer"))).status, 403);
    assert.equal((await POST(request({ action: "invite", email: "qa@example.invalid", role: "admin" }, "owner", "http://hostile.invalid"))).status, 403);
    assert.equal((await POST(request({ action: "invite", email: "qa@example.invalid", role: "admin" }, "owner", ""))).status, 403);
    assert.equal((await POST(request({ action: "invite", email: "not-email", role: "admin" }))).status, 400);
    assert.equal((await POST(request({ action: "invite", email: "qa@example.invalid", role: "superuser" }))).status, 400);
    const invited = await POST(request({ action: "invite", email: "qa@example.invalid", role: "viewer" }));
    assert.equal(invited.status, 201);
    assert.equal(invited.headers.get("cache-control"), "no-store");
    const pending = (await invited.json()).user;
    assert.equal(pending.configured, false);
    assert.equal(pending.role, "viewer");
    assert.ok(!JSON.stringify(pending).includes("passwordHash"));
    assert.equal((await POST(request({ action: "invite", email: "qa@example.invalid", role: "viewer" }))).status, 409);
    const code = await auth.createAdminLoginCode("qa@example.invalid");
    assert.equal(code.mode, "setup");
    const configured = await auth.setupAdminAccount({
      email: "qa@example.invalid", code: code.code, username: "Quality Tester",
      clientPasswordHash: "a".repeat(64),
    });
    assert.equal(configured.configured, true);
    const session = await auth.createAdminSession("qa@example.invalid");
    assert.equal((await auth.getAdminSession(session.token)).role, "viewer");
    const before = await GET(new Request(url, { headers: { cookie: cookie("owner") } }));
    const account = (await before.json()).users.find((item) => item.email === "qa@example.invalid");
    assert.equal(account.username, "Quality Tester");
    assert.ok(!JSON.stringify(account).includes("passwordSalt"));
    assert.equal((await POST(request({ action: "role", email: account.email, role: "admin", version: 99 }))).status, 409);
    assert.equal((await POST(request({ action: "role", email: account.email, role: "admin", version: account.version }))).status, 200);
    assert.equal(await auth.getAdminSession(session.token), null);
    assert.equal((await auth.createAdminSession(account.email)).user.role, "admin");
    assert.equal((await POST(request({ action: "revoke", email: account.email, version: account.version }))).status, 409);
    assert.equal((await POST(request({ action: "revoke", email: "owner@example.invalid", version: 1 }))).status, 400);
    const changed = (await (await GET(new Request(url, { headers: { cookie: cookie("owner") } }))).json()).users.find((item) => item.email === account.email);
    assert.equal((await POST(request({ action: "revoke", email: account.email, version: changed.version }))).status, 200);
    assert.equal((await auth.getAdminAuthState()).users.some((item) => item.email === account.email), false);
    assert.equal((await POST(request({ action: "invite", email: account.email, role: "admin" }))).status, 201);
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ADMIN_AUTH_SECRET: secret, ADMIN_AUTH_FILE: "admin-users.json", ADMIN_APP_ORIGIN: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    const store = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(store.users.filter((item) => item.email === "qa@example.invalid").length, 1);
    assert.equal(store.users.find((item) => item.email === "qa@example.invalid").passwordHash, "");
  } finally {
    assert.equal(path.dirname(dir), tmpdir());
    rmSync(dir, { recursive: true });
  }
});

test("two workers preserve concurrent JSON account invitations", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rec-admin-users-lock-"));
  const file = path.join(dir, "data", "admin", "admin-users.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    version: 1,
    users: [{
      email: "owner@example.invalid",
      username: "Owner",
      passwordHash: "hash",
      passwordSalt: "salt",
      role: "owner",
    }],
    loginCodes: [],
    sessions: [],
  }));
  const authUrl = new URL("../src/lib/admin-auth.js", import.meta.url).href;
  const worker = (prefix) => new Promise((resolve, reject) => {
    const script = `
      const { inviteAdminUser } = await import(${JSON.stringify(authUrl)});
      await Promise.all(Array.from({ length: 8 }, (_, index) =>
        inviteAdminUser({ email: ${JSON.stringify(prefix)} + index + "@example.invalid",
          role: "viewer", actorEmail: "owner@example.invalid" })
      ));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir,
      env: { ...process.env, ADMIN_AUTH_FILE: "admin-users.json" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  try {
    await Promise.all([worker("left"), worker("right")]);
    const store = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(store.users.length, 17);
    assert.equal(new Set(store.users.map((item) => item.email)).size, 17);
  } finally {
    assert.equal(path.dirname(dir), tmpdir());
    rmSync(dir, { recursive: true });
  }
});
