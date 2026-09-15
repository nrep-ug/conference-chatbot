import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("real admin handlers require session, role, origin and version; keys are one-time responses", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rec-admin-api-"));
  const file = path.join(dir, "data", "admin", "admin-users.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const secret = "isolated-admin-test-secret";
  const users = [
    { email: "owner@example.invalid", username: "Owner", passwordHash: "hash", passwordSalt: "salt", role: "owner" },
    { email: "admin@example.invalid", username: "Admin", passwordHash: "hash", passwordSalt: "salt", role: "admin" },
    { email: "viewer@example.invalid", username: "Viewer", passwordHash: "hash", passwordSalt: "salt", role: "viewer" },
  ];
  writeFileSync(file, JSON.stringify({ users, sessions: users.map((user) => ({
    email: user.email, tokenHash: createHmac("sha256", secret).update(user.role).digest("hex"),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  })) }));
  const moduleUrl = new URL("../src/app/api/admin/integrations/route.js", import.meta.url).href;
  const script = [
    'import assert from "node:assert/strict";',
    'const {GET,POST}=await import(' + JSON.stringify(moduleUrl) + ');',
    'const url="http://localhost/api/admin/integrations";',
    'const req=(body,token="admin",origin="http://localhost")=>new Request(url,{method:"POST",headers:{"Content-Type":"application/json",cookie:"rec_admin_session="+token,...(origin?{origin}:{})},body:JSON.stringify(body)});',
    'assert.equal((await GET(new Request(url))).status,401);',
    'assert.equal((await POST(req({action:"create",settings:{name:"Test app"}},"viewer"))).status,403);',
    'assert.equal((await POST(req({action:"create",settings:{name:"Test app"}},"admin","http://hostile.invalid"))).status,403);',
    'assert.equal((await GET(new Request(url,{headers:{cookie:"rec_admin_session=owner"}}))).status,200);',
    'const created=await POST(req({action:"create",settings:{name:"Test app"}},"owner")); assert.equal(created.status,201);',
    'const data=await created.json(); assert.ok(data.key); const id=data.integration.id;',
    'assert.equal(created.headers.get("cache-control"),"no-store");',
    'const listed=await GET(new Request(url,{headers:{cookie:"rec_admin_session=admin"}}));',
    'const list=await listed.json(); assert.equal(list.integrations.length,1); assert.ok(!JSON.stringify(list).includes(data.key));',
    'assert.equal((await GET(new Request(url,{headers:{cookie:"rec_admin_session=viewer"}}))).status,200);',
    'assert.equal((await POST(req({action:"update",id,version:1,settings:{enabled:false}}))).status,200);',
    'assert.equal((await POST(req({action:"update",id,version:1,settings:{enabled:true}}))).status,409);',
    'const rotated=await (await POST(req({action:"rotate",id,version:2}))).json(); assert.ok(rotated.key); assert.notEqual(rotated.key,data.key);',
    'assert.equal((await POST(req({action:"revoke",id,version:3}))).status,200);',
    'assert.equal((await POST(req({action:"update",id,version:4,settings:{enabled:true}}))).status,409);',
  ].join("\n");
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir, encoding: "utf8", env: {
        ...process.env, ADMIN_AUTH_SECRET: secret, ADMIN_AUTH_FILE: "admin-users.json",
        ADMIN_APP_ORIGIN: "", CHAT_API_DB_FILE: path.join(dir, "integrations.sqlite"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    assert.equal(path.dirname(dir), tmpdir());
    rmSync(dir, { recursive: true });
  }
});
