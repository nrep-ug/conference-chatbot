import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export const ADMIN_SESSION_COOKIE = "rec_admin_session";

const ADMIN_DATA_DIR = path.join(process.cwd(), "data", "admin");
const AUTH_FILE = path.join(
  ADMIN_DATA_DIR,
  path.basename(process.env.ADMIN_AUTH_FILE || "admin-users.json")
);
const AUTH_EXAMPLE_FILE = path.join(ADMIN_DATA_DIR, "admin-users.example.json");
const SESSION_TTL_MS = readInteger(
  "ADMIN_SESSION_TTL_MS",
  7 * 24 * 60 * 60 * 1000
);
const CODE_TTL_MS = readInteger("ADMIN_LOGIN_CODE_TTL_MS", 10 * 60 * 1000);
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
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
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
    await writeStore(seed);
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
    configured: isUserConfigured(user),
    createdAt: user.createdAt || "",
    updatedAt: user.updatedAt || "",
    lastLoginAt: user.lastLoginAt || "",
  };
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
  let store = cleanExpired(await readStore());
  await writeStore(store);

  return {
    configuredUsers: store.users.filter(isUserConfigured).length,
    allowedUsers: store.users.length,
    users: store.users.map(sanitizeUser),
    authFile: AUTH_FILE,
    hasStableSecret: hasStableAuthSecret(),
  };
}

export async function createAdminLoginCode(email) {
  const store = cleanExpired(await readStore());
  const normalizedEmail = normalizeEmail(email);
  const user = findUser(store, normalizedEmail);

  if (!user) {
    throw new Error("This email is not allowed to access the admin console.");
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
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
    });

  await writeStore(store);

  return {
    code,
    email: normalizedEmail,
    mode: isUserConfigured(user) ? "login" : "setup",
    expiresAt,
  };
}

function verifyCodeInStore(store, email, code) {
  const normalizedEmail = normalizeEmail(email);
  const expectedHash = hmac(`${normalizedEmail}:${String(code || "").trim()}`);
  const item = store.loginCodes.find(
    (entry) =>
      entry.email === normalizedEmail &&
      new Date(entry.expiresAt).getTime() > Date.now() &&
      constantEqual(entry.codeHash, expectedHash)
  );

  if (!item) {
    throw new Error("The verification code is invalid or expired.");
  }

  store.loginCodes = store.loginCodes.filter((entry) => entry !== item);
}

export async function setupAdminAccount({
  email,
  code,
  username,
  clientPasswordHash,
}) {
  const store = cleanExpired(await readStore());
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

  verifyCodeInStore(store, normalizedEmail, code);
  const password = await hashPassword(clientPasswordHash);
  const timestamp = nowIso();

  user.username = cleanUsername;
  user.passwordHash = password.passwordHash;
  user.passwordSalt = password.passwordSalt;
  user.passwordParams = password.passwordParams;
  user.createdAt = timestamp;
  user.updatedAt = timestamp;

  await writeStore(store);

  return sanitizeUser(user);
}

export async function loginAdmin({ email, code, clientPasswordHash }) {
  const store = cleanExpired(await readStore());
  const normalizedEmail = normalizeEmail(email);
  const user = findUser(store, normalizedEmail);

  if (!user || !isUserConfigured(user)) {
    throw new Error("Admin account is not configured.");
  }

  verifyCodeInStore(store, normalizedEmail, code);

  if (!(await verifyPassword(clientPasswordHash, user))) {
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
  user.lastLoginAt = timestamp;
  await writeStore(store);

  return {
    token,
    expiresAt,
    user: sanitizeUser(user),
  };
}

export async function createAdminSession(email) {
  const store = cleanExpired(await readStore());
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
}

export async function getAdminSession(token) {
  if (!token) return null;

  const store = cleanExpired(await readStore());
  const tokenHash = hmac(token);
  const session = store.sessions.find((item) =>
    constantEqual(item.tokenHash, tokenHash)
  );

  if (!session) {
    await writeStore(store);
    return null;
  }

  const user = findUser(store, session.email);
  await writeStore(store);

  return user ? sanitizeUser(user) : null;
}

export async function destroyAdminSession(token) {
  if (!token) return;

  const store = cleanExpired(await readStore());
  const tokenHash = hmac(token);
  store.sessions = store.sessions.filter(
    (session) => !constantEqual(session.tokenHash, tokenHash)
  );
  await writeStore(store);
}

export function getSessionCookie(token, expiresAt) {
  const secure = process.env.NODE_ENV === "production" ? "Secure" : "";

  return [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure.trim(),
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function getClearSessionCookie() {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
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
