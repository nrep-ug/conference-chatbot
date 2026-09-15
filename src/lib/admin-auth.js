import {
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export const ADMIN_SESSION_COOKIE = "rec_admin_session";

const ADMIN_DATA_DIR = path.join(process.cwd(), "data", "admin");
const AUTH_FILE = path.join(
  ADMIN_DATA_DIR,
  path.basename(process.env.ADMIN_AUTH_FILE || "admin-users.json")
);
const AUTH_EXAMPLE_FILE = path.join(ADMIN_DATA_DIR, "admin-users.example.json");
const AUTH_LOCK_FILE = `${AUTH_FILE}.lock`;
const SESSION_TTL_MS = readInteger(
  "ADMIN_SESSION_TTL_MS",
  7 * 24 * 60 * 60 * 1000
);
const CODE_TTL_MS = readInteger("ADMIN_LOGIN_CODE_TTL_MS", 10 * 60 * 1000);
const CODE_COOLDOWN_MS = readInteger(
  "ADMIN_LOGIN_CODE_COOLDOWN_MS",
  60 * 1000
);
const CODE_MAX_ATTEMPTS = 5;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_PARAMS = {
  name: "scrypt",
  N: 16384,
  r: 8,
  p: 1,
  keyLength: PASSWORD_KEY_LENGTH,
};
const PROCESS_SECRET = randomBytes(32).toString("hex");

function readInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getAuthSecret() {
  return (
    process.env.ADMIN_AUTH_SECRET ||
    process.env.REC_REFRESH_TOKEN ||
    process.env.APPWRITE_API_KEY ||
    PROCESS_SECRET
  );
}

function hasStableAuthSecret() {
  return Boolean(
    process.env.ADMIN_AUTH_SECRET ||
      process.env.REC_REFRESH_TOKEN ||
      process.env.APPWRITE_API_KEY
  );
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function mutateStore(change) {
  await mkdir(ADMIN_DATA_DIR, { recursive: true, mode: 0o700 });
  const started = Date.now();
  let lock;
  while (!lock) {
    try {
      lock = await open(AUTH_LOCK_FILE, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const info = await stat(AUTH_LOCK_FILE);
        if (Date.now() - info.mtimeMs > 120000) await unlink(AUTH_LOCK_FILE);
      } catch (inspectionError) {
        if (inspectionError.code !== "ENOENT") throw inspectionError;
      }
      if (Date.now() - started > 5000)
        throw new Error("Admin accounts are busy. Please retry shortly.");
      await delay(35);
    }
  }
  try {
    return await change(cleanExpired(await readStore()));
  } finally {
    await lock.close();
    await unlink(AUTH_LOCK_FILE).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function normalizeStore(store) {
  return {
    version: 1,
    users: Array.isArray(store?.users)
      ? store.users.map((user) => ({
          email: normalizeEmail(user.email),
          username: user.username || "",
          passwordHash: user.passwordHash || "",
          passwordSalt: user.passwordSalt || "",
          passwordParams: user.passwordParams || null,
          role: user.role || "admin",
          version: Number.isSafeInteger(user.version) && user.version > 0 ? user.version : 1,
          createdAt: user.createdAt || "",
          updatedAt: user.updatedAt || "",
          lastLoginAt: user.lastLoginAt || "",
        }))
      : [],
    loginCodes: Array.isArray(store?.loginCodes) ? store.loginCodes : [],
    sessions: Array.isArray(store?.sessions) ? store.sessions : [],
  };
}

async function readStore() {
  try {
    return normalizeStore(JSON.parse(await readFile(AUTH_FILE, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    const seed = normalizeStore(
      JSON.parse(await readFile(AUTH_EXAMPLE_FILE, "utf8"))
    );
    return seed;
  }
}

async function writeStore(store) {
  await writeAtomic(AUTH_FILE, `${JSON.stringify(normalizeStore(store), null, 2)}\n`);
}

function cleanExpired(store) {
  const now = Date.now();
  return {
    ...store,
    loginCodes: store.loginCodes.filter(
      (code) => new Date(code.expiresAt).getTime() > now
    ),
    sessions: store.sessions.filter(
      (session) => new Date(session.expiresAt).getTime() > now
    ),
  };
}

function hashSecret(value) {
  return createHmac("sha256", getAuthSecret()).update(String(value)).digest("hex");
}

function hmac(value) {
  return hashSecret(value);
}

function constantEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  if (leftBuffer.length !== rightBuffer.length) return false;

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function findUser(store, email) {
  const normalizedEmail = normalizeEmail(email);
  return store.users.find((user) => user.email === normalizedEmail);
}

function isUserConfigured(user) {
  return Boolean(user?.username && user?.passwordHash && user?.passwordSalt);
}

function sanitizeUser(user) {
  if (!user) return null;

  return {
    email: user.email,
    username: user.username || "",
    role: user.role || "admin",
    version: user.version || 1,
    configured: isUserConfigured(user),
    createdAt: user.createdAt || "",
    updatedAt: user.updatedAt || "",
    lastLoginAt: user.lastLoginAt || "",
  };
}

export function isAdministrator(user) {
  return user?.role === "owner" || user?.role === "admin";
}

export function isOwner(user) {
  return user?.role === "owner";
}

function validateAccountRole(role) {
  if (!["owner", "admin", "viewer"].includes(role))
    throw new Error("Choose owner, administrator, or viewer access.");
  return role;
}

function validateAccountEmail(email) {
  const value = normalizeEmail(email);
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new Error("Enter a valid email address.");
  return value;
}

function requireAccountVersion(user, version) {
  if (!Number.isSafeInteger(version) || user.version !== version)
    throw new Error("This account changed. Refresh the list and try again.");
}

function protectOwnerAccess(store, user, actorEmail) {
  if (user.email === normalizeEmail(actorEmail))
    throw new Error("You cannot remove or change your own access.");
  if (
    user.role === "owner" &&
    store.users.filter((item) => item.role === "owner" && isUserConfigured(item)).length <= 1
  )
    throw new Error("The last configured owner cannot be removed.");
}

function verifyOwnerActor(store, actorEmail) {
  const actor = findUser(store, actorEmail);
  if (!actor || !isOwner(actor) || !isUserConfigured(actor))
    throw new Error("Owner access is required.");
}

export async function inviteAdminUser({ email, role, actorEmail }) {
  const cleanEmail = validateAccountEmail(email);
  const cleanRole = validateAccountRole(role);
  return mutateStore(async (store) => {
    verifyOwnerActor(store, actorEmail);
    if (findUser(store, cleanEmail))
      throw new Error("This email is already approved.");
    const timestamp = nowIso();
    const user = {
      email: cleanEmail,
      username: "",
      passwordHash: "",
      passwordSalt: "",
      passwordParams: null,
      role: cleanRole,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastLoginAt: "",
    };
    store.users.push(user);
    await writeStore(store);
    return sanitizeUser(user);
  });
}

export async function changeAdminUserRole({ email, role, version, actorEmail }) {
  const cleanEmail = validateAccountEmail(email);
  const cleanRole = validateAccountRole(role);
  return mutateStore(async (store) => {
    verifyOwnerActor(store, actorEmail);
    const user = findUser(store, cleanEmail);
    if (!user) throw new Error("Account not found.");
    requireAccountVersion(user, version);
    if (user.role === cleanRole) return sanitizeUser(user);
    protectOwnerAccess(store, user, actorEmail);
    user.role = cleanRole;
    user.version += 1;
    user.updatedAt = nowIso();
    store.sessions = store.sessions.filter((session) => session.email !== cleanEmail);
    await writeStore(store);
    return sanitizeUser(user);
  });
}

export async function revokeAdminUser({ email, version, actorEmail }) {
  const cleanEmail = validateAccountEmail(email);
  return mutateStore(async (store) => {
    verifyOwnerActor(store, actorEmail);
    const user = findUser(store, cleanEmail);
    if (!user) throw new Error("Account not found.");
    requireAccountVersion(user, version);
    protectOwnerAccess(store, user, actorEmail);
    store.users = store.users.filter((item) => item.email !== cleanEmail);
    store.sessions = store.sessions.filter((session) => session.email !== cleanEmail);
    store.loginCodes = store.loginCodes.filter((code) => code.email !== cleanEmail);
    await writeStore(store);
    return sanitizeUser(user);
  });
}

function validateClientPasswordHash(clientPasswordHash) {
  const value = String(clientPasswordHash || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Password digest is invalid.");
  }

  return value.toLowerCase();
}

async function hashPassword(clientPasswordHash) {
  const digest = validateClientPasswordHash(clientPasswordHash);
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(digest, salt, PASSWORD_KEY_LENGTH, {
    N: PASSWORD_PARAMS.N,
    r: PASSWORD_PARAMS.r,
    p: PASSWORD_PARAMS.p,
  });

  return {
    passwordHash: Buffer.from(derived).toString("hex"),
    passwordSalt: salt,
    passwordParams: PASSWORD_PARAMS,
  };
}

async function verifyPassword(clientPasswordHash, user) {
  const digest = validateClientPasswordHash(clientPasswordHash);
  const params = user.passwordParams || PASSWORD_PARAMS;
  const derived = await scrypt(digest, user.passwordSalt, params.keyLength || 64, {
    N: params.N || PASSWORD_PARAMS.N,
    r: params.r || PASSWORD_PARAMS.r,
    p: params.p || PASSWORD_PARAMS.p,
  });

  return constantEqual(Buffer.from(derived).toString("hex"), user.passwordHash);
}

export async function getAdminAuthState() {
  const store = cleanExpired(await readStore());

  return {
    configuredUsers: store.users.filter(isUserConfigured).length,
    allowedUsers: store.users.length,
    users: store.users.map(sanitizeUser),
    authFile: AUTH_FILE,
    hasStableSecret: hasStableAuthSecret(),
  };
}

export async function createAdminLoginCode(email) {
  return mutateStore(async (store) => {
    const normalizedEmail = normalizeEmail(email);
    const user = findUser(store, normalizedEmail);

    if (!user) {
      throw new Error("This email is not allowed to access the admin console.");
    }

    const existingCode = store.loginCodes.find(
      (item) => item.email === normalizedEmail
    );
    const existingCodeAge = existingCode
      ? Date.now() - new Date(existingCode.createdAt).getTime()
      : Number.POSITIVE_INFINITY;

    if (existingCode && existingCodeAge < CODE_COOLDOWN_MS) {
      if ((existingCode.failedAttempts || 0) >= CODE_MAX_ATTEMPTS)
        throw new Error("Too many verification attempts. Request a new code shortly.");
      return {
        code: "",
        email: normalizedEmail,
        mode: isUserConfigured(user) ? "login" : "setup",
        expiresAt: existingCode.expiresAt,
        reused: true,
      };
    }

    const code = String(randomInt(100000, 1000000));
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    const codeHash = hmac(`${normalizedEmail}:${code}`);

    store.loginCodes = store.loginCodes
      .filter((item) => item.email !== normalizedEmail)
      .concat({
        email: normalizedEmail,
        codeHash,
        createdAt,
        expiresAt,
        failedAttempts: 0,
      });

    await writeStore(store);

    return {
      code,
      email: normalizedEmail,
      mode: isUserConfigured(user) ? "login" : "setup",
      expiresAt,
      reused: false,
    };
  });
}

export async function invalidateAdminLoginCode(email, code) {
  return mutateStore(async (store) => {
    const normalizedEmail = normalizeEmail(email);
    const expectedHash = hmac(`${normalizedEmail}:${String(code || "").trim()}`);
    const matching = store.loginCodes.find(
      (item) =>
        item.email === normalizedEmail &&
        constantEqual(item.codeHash, expectedHash),
    );
    if (!matching) return false;
    store.loginCodes = store.loginCodes.filter((item) => item !== matching);
    await writeStore(store);
    return true;
  });
}

async function verifyCodeInStore(store, email, code) {
  const normalizedEmail = normalizeEmail(email);
  const expectedHash = hmac(`${normalizedEmail}:${String(code || "").trim()}`);
  const item = store.loginCodes.find(
    (entry) =>
      entry.email === normalizedEmail &&
      new Date(entry.expiresAt).getTime() > Date.now()
  );

  if (!item || (item.failedAttempts || 0) >= CODE_MAX_ATTEMPTS) {
    throw new Error("The verification code is invalid or expired.");
  }

  if (!constantEqual(item.codeHash, expectedHash)) {
    item.failedAttempts = (item.failedAttempts || 0) + 1;
    await writeStore(store);
    throw new Error("The verification code is invalid or expired.");
  }

  return item;
}

export async function setupAdminAccount({
  email,
  code,
  username,
  clientPasswordHash,
}) {
  return mutateStore(async (store) => {
    const normalizedEmail = normalizeEmail(email);
    const user = findUser(store, normalizedEmail);

    if (!user) {
      throw new Error("This email is not allowed to access the admin console.");
    }

    if (isUserConfigured(user)) {
      throw new Error("This admin account has already been configured.");
    }

    const cleanUsername = String(username || "").trim();
    if (cleanUsername.length < 3) {
      throw new Error("Username must be at least 3 characters.");
    }

    const verifiedCode = await verifyCodeInStore(store, normalizedEmail, code);
    const password = await hashPassword(clientPasswordHash);
    const timestamp = nowIso();

    user.username = cleanUsername;
    user.passwordHash = password.passwordHash;
    user.passwordSalt = password.passwordSalt;
    user.passwordParams = password.passwordParams;
    user.createdAt ||= timestamp;
    user.updatedAt = timestamp;
    store.loginCodes = store.loginCodes.filter((item) => item !== verifiedCode);

    await writeStore(store);

    return sanitizeUser(user);
  });
}

export async function loginAdmin({ email, code, clientPasswordHash }) {
  return mutateStore(async (store) => {
    const normalizedEmail = normalizeEmail(email);
    const user = findUser(store, normalizedEmail);

    if (!user || !isUserConfigured(user)) {
      throw new Error("Admin account is not configured.");
    }

    const verifiedCode = await verifyCodeInStore(store, normalizedEmail, code);

    if (!(await verifyPassword(clientPasswordHash, user))) {
      verifiedCode.failedAttempts = (verifiedCode.failedAttempts || 0) + 1;
      await writeStore(store);
      throw new Error("Invalid admin credentials.");
    }

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const timestamp = nowIso();

    store.sessions.push({
      email: normalizedEmail,
      tokenHash: hmac(token),
      createdAt: timestamp,
      expiresAt,
    });
    store.loginCodes = store.loginCodes.filter((item) => item !== verifiedCode);
    user.lastLoginAt = timestamp;
    await writeStore(store);

    return {
      token,
      expiresAt,
      user: sanitizeUser(user),
    };
  });
}

export async function createAdminSession(email) {
  return mutateStore(async (store) => {
    const normalizedEmail = normalizeEmail(email);
    const user = findUser(store, normalizedEmail);

    if (!user || !isUserConfigured(user)) {
      throw new Error("Admin account is not configured.");
    }

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const timestamp = nowIso();

    store.sessions.push({
      email: normalizedEmail,
      tokenHash: hmac(token),
      createdAt: timestamp,
      expiresAt,
    });
    user.lastLoginAt = timestamp;
    await writeStore(store);

    return {
      token,
      expiresAt,
      user: sanitizeUser(user),
    };
  });
}

export async function getAdminSession(token) {
  if (!token) return null;

  const store = cleanExpired(await readStore());
  const tokenHash = hmac(token);
  const session = store.sessions.find((item) =>
    constantEqual(item.tokenHash, tokenHash)
  );

  if (!session) {
    return null;
  }

  const user = findUser(store, session.email);

  return user ? sanitizeUser(user) : null;
}

export async function destroyAdminSession(token) {
  if (!token) return;

  return mutateStore(async (store) => {
    const tokenHash = hmac(token);
    store.sessions = store.sessions.filter(
      (session) => !constantEqual(session.tokenHash, tokenHash)
    );
    await writeStore(store);
  });
}

export function getSessionCookie(token, expiresAt) {
  const secure = process.env.NODE_ENV === "production" ? "Secure" : "";

  return [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure.trim(),
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function getClearSessionCookie() {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function getCookieValue(request, name) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookies = Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, ...value] = part.split("=");
        return [key, decodeURIComponent(value.join("="))];
      })
  );

  return cookies[name] || "";
}

export async function requireAdmin(request) {
  const token = getCookieValue(request, ADMIN_SESSION_COOKIE);
  const user = await getAdminSession(token);

  if (!user) {
    return {
      user: null,
      response: Response.json({ error: "Unauthorized." }, { status: 401 }),
    };
  }

  return { user, response: null };
}
