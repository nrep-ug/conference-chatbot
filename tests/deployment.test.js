import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const available = spawnSync(bash, ["--version"], { windowsHide: true }).status === 0;
const shellPath = (path) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

async function deploy(t, options = {}, args = []) {
  const root = await mkdtemp(join(tmpdir(), "rec deployment-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  for (const folder of ["scripts", "pm2", ".git", "bin"]) await mkdir(join(root, folder));
  const script = join(root, "scripts/deploy-vps.sh");
  await copyFile(new URL("../scripts/deploy-vps.sh", import.meta.url), script);
  for (const file of [".env.local", "package-lock.json", "pm2/ecosystem.config.js"]) await writeFile(join(root, file), "fixture\n");
  const traceFile = join(root, "trace.log");
  for (const name of ["git", "npm", "node", "pm2", "flock"]) {
    await writeFile(join(root, "bin", name), `#!/usr/bin/env bash
set -eu
printf '%s\\n' '${name}'" $*" >> "$TRACE_FILE"
[[ "${name} $*" != "\${MOCK_FAIL:-}" ]] || exit 1
if [[ '${name}' == pm2 ]] && { true >&9; } 2>/dev/null; then
  printf '%s\\n' 'Deployment lock descriptor leaked to PM2' >&2
  exit 77
fi
case '${name} '"$*" in
  'git rev-parse --git-common-dir') printf '%s\\n' '.git' ;;
  'git branch --show-current') printf '%s\\n' "\${MOCK_BRANCH:-main}" ;;
  'git rev-parse HEAD') printf '%s\\n' 'fixture-revision' ;;
  'git status --porcelain --untracked-files=normal')
    if [[ "\${MOCK_DIRTY:-}" == yes || -e .dependency-drift ]]; then printf '%s\\n' ' M package-lock.json'; fi ;;
  'npm ci') [[ "\${MOCK_DRIFT:-}" != yes ]] || touch .dependency-drift ;;
  'git merge --ff-only FETCH_HEAD')
    if [[ "\${MOCK_REPLACE_SCRIPT:-}" == yes ]]; then printf '%s\\n' 'exit 99' > scripts/deploy-vps.sh; fi ;;
esac
`, { mode: 0o755 });
  }
  const wrapper = 'export PATH="$MOCK_BIN:/usr/bin:/bin"; hash -r; for cmd in git npm node pm2 flock; do [[ "$(command -v "$cmd")" == "$MOCK_BIN/$cmd" ]] || exit 89; done; source "$MOCK_SCRIPT" "$@"';
  const result = spawnSync(bash, ["--noprofile", "--norc", "-c", wrapper, "deployment-test", ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, MOCK_BIN: shellPath(join(root, "bin")), MOCK_SCRIPT: shellPath(script), TRACE_FILE: shellPath(traceFile), ...options },
  });
  assert.ifError(result.error);
  return { ...result, trace: (await readFile(traceFile, "utf8").catch(() => "")).trim().split("\n") };
}

test("deployment stops before mutating files, verifies both API paths and saves only after readiness", { skip: !available }, async (t) => {
  const result = await deploy(t, {}, ["--models"]);
  assert.equal(result.status, 0, result.stderr);
  const order = ["pm2 stop rec-expo-chatbot", "git merge --ff-only FETCH_HEAD", "npm ci", "npm test", "npm run build",
    "pm2 startOrReload pm2/ecosystem.config.js --update-env", "node --env-file=.env.local scripts/check-chat-api.js --public-url https://chat.nrep.ug", "pm2 save", "npm run eval:chat -- --models"];
  for (let i = 1; i < order.length; i++) assert.ok(result.trace.indexOf(order[i]) > result.trace.indexOf(order[i - 1]), result.trace.join("\n"));
  assert.equal(result.trace.filter((line) => line === "npm run build").length, 1);
  assert.doesNotMatch(result.trace.join("\n"), /git reset|git stash/);
});

test("dirty worktrees, wrong branches, lock conflicts, bad configuration and diverged branches leave the app untouched", { skip: !available }, async (t) => {
  for (const options of [
    { MOCK_DIRTY: "yes" }, { MOCK_BRANCH: "feature" }, { MOCK_FAIL: "flock -n 9" },
    { MOCK_FAIL: "node --env-file=.env.local scripts/check-chat-api.js --public-url https://chat.nrep.ug --validate-only" },
    { MOCK_FAIL: "git merge-base --is-ancestor HEAD FETCH_HEAD" }, { MOCK_FAIL: "pm2 describe rec-expo-chatbot" },
  ]) {
    const result = await deploy(t, options);
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.ok(!result.trace.includes("pm2 stop rec-expo-chatbot"));
    assert.ok(!result.trace.includes("npm ci"));
    assert.match(result.stderr, /running application was not changed/);
  }
});

test("install, test and build failures never restart a partial deployment", { skip: !available }, async (t) => {
  for (const failure of ["npm ci", "npm test", "npm run build"]) {
    const result = await deploy(t, { MOCK_FAIL: failure });
    assert.notEqual(result.status, 0);
    assert.ok(result.trace.includes("pm2 stop rec-expo-chatbot"));
    assert.ok(!result.trace.some((line) => line.startsWith("pm2 startOrReload")));
    assert.ok(!result.trace.includes("pm2 save"));
    assert.match(result.stderr, /No rollback or automatic restart/);
  }
});

test("dependency-induced lockfile drift is not silently deployed", { skip: !available }, async (t) => {
  const result = await deploy(t, { MOCK_DRIFT: "yes" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package-lock.json/);
  assert.ok(!result.trace.includes("npm test"));
});

test("API readiness failure cannot be saved or reported as deployment success", { skip: !available }, async (t) => {
  const result = await deploy(t, { MOCK_FAIL: "node --env-file=.env.local scripts/check-chat-api.js --public-url https://chat.nrep.ug" });
  assert.notEqual(result.status, 0);
  assert.ok(!result.trace.includes("pm2 save"));
  assert.doesNotMatch(result.stdout, /Deployment completed/);
});

test("quality failure is distinguished from deployment failure and leaves the healthy app running", { skip: !available }, async (t) => {
  const result = await deploy(t, { MOCK_FAIL: "npm run eval:chat -- --models" }, ["--models"]);
  assert.equal(result.status, 2);
  assert.ok(result.trace.includes("pm2 save"));
  assert.equal(result.trace.filter((line) => line === "pm2 stop rec-expo-chatbot").length, 1);
  assert.match(result.stderr, /passed readiness and remains running/);
});

test("deployment continues from its parsed body if git replaces the script itself", { skip: !available }, async (t) => {
  const result = await deploy(t, { MOCK_REPLACE_SCRIPT: "yes" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.trace.includes("pm2 save"));
});

test("deployment accepts a public URL override and does not run inference by default", { skip: !available }, async (t) => {
  const result = await deploy(t, {}, ["--public-url", "https://alternate.example.org"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.trace.includes("node --env-file=.env.local scripts/check-chat-api.js --public-url https://alternate.example.org"));
  assert.ok(!result.trace.some((line) => line.startsWith("npm run eval:chat")));
});
