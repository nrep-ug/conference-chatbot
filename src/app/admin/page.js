"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const EMAIL_STATE = {
  idle: "idle",
  sent: "sent",
};

const quickChecks = [
  "Ask a finance recommendation question",
  "Ask about preparation across four days",
  "Ask for the Day 3 schedule",
  "Ask for sponsors and partners",
];

function getQdrantStatusLabel(vectorStore) {
  if (vectorStore?.ok) return "Qdrant ready";
  if (vectorStore?.issue === "empty_collection") return "Qdrant empty";
  if (vectorStore?.issue === "missing_collection") return "Qdrant collection missing";
  return "Qdrant unreachable";
}

function classNames(...values) {
  return values.filter(Boolean).join(" ");
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "The request failed.");
  }

  return data;
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchStatusData() {
  const response = await fetch("/api/admin/bot/status", { cache: "no-store" });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unable to load bot status.");
  }

  return {
    ...data,
    receivedAt: Date.now(),
  };
}

function getGeneratedAge(generatedAt, referenceNow) {
  if (!generatedAt) return "Not generated";

  const hours = Math.round((referenceNow - Date.parse(generatedAt)) / 36e5);
  return hours <= 0 ? "Fresh" : `${hours}h old`;
}

function Icon({ name, className = "" }) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };

  const paths = {
    activity: (
      <>
        <path d="M3 12h4l2.5-6 5 12L17 12h4" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5" rx="7" ry="3" />
        <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
        <path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 6v5h-5" />
        <path d="M4 18v-5h5" />
        <path d="M18.4 9A7 7 0 0 0 6.2 6.8L4 9" />
        <path d="M5.6 15a7 7 0 0 0 12.2 2.2L20 15" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3 5 6v5c0 4.3 2.9 8.3 7 9.5 4.1-1.2 7-5.2 7-9.5V6l-7-3Z" />
        <path d="m9.5 12 1.8 1.8 3.7-4" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 1.5 5L19 9.5 13.5 11 12 17l-1.5-6L5 9.5 10.5 8 12 3Z" />
        <path d="M19 17v4" />
        <path d="M17 19h4" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M5 21a7 7 0 0 1 14 0" />
      </>
    ),
    vector: (
      <>
        <path d="M6 7a3 3 0 1 0 0 .1" />
        <path d="M18 7a3 3 0 1 0 0 .1" />
        <path d="M12 18a3 3 0 1 0 0 .1" />
        <path d="M8.5 8.5 10.8 15" />
        <path d="M15.5 8.5 13.2 15" />
        <path d="M9 7h6" />
      </>
    ),
  };

  return <svg {...common}>{paths[name]}</svg>;
}

function StatusPill({ ok, label }) {
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold",
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-amber-200 bg-amber-50 text-amber-700"
      )}
    >
      <span
        className={classNames(
          "h-1.5 w-1.5 rounded-full",
          ok ? "bg-emerald-500" : "bg-amber-500"
        )}
      />
      {label}
    </span>
  );
}

function MetricCard({ icon, label, value, detail }) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-normal text-slate-950">
            {value}
          </p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-950 text-white">
          <Icon name={icon} className="h-5 w-5" />
        </div>
      </div>
      {detail && <p className="mt-4 text-sm leading-6 text-slate-500">{detail}</p>}
    </article>
  );
}

function AuthPanel({ authState, onAuthenticated }) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState("login");
  const [emailState, setEmailState] = useState(EMAIL_STATE.idle);
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function requestCode(event) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const response = await postJson("/api/admin/auth/code", { email });
      setMode(response.mode);
      setExpiresAt(response.expiresAt);
      setEmailState(EMAIL_STATE.sent);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCredentials(event) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const passwordHash = await sha256Hex(password);
      const endpoint =
        mode === "setup" ? "/api/admin/auth/setup" : "/api/admin/auth/login";
      await postJson(endpoint, {
        email,
        username,
        passwordHash,
        code,
      });
      onAuthenticated();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto grid min-h-screen max-w-6xl gap-10 px-6 py-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <section className="py-8">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-400 text-slate-950">
            <Icon name="shield" className="h-6 w-6" />
          </div>
          <h1 className="mt-8 max-w-xl text-4xl font-semibold leading-tight tracking-normal sm:text-5xl">
            REC Bot Admin Console
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-slate-300">
            Manage the chatbot data pipeline, vector index, runtime health, and
            secure admin access from one quiet operational surface.
          </p>
          <div className="mt-8 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
            {[
              "Email verification before every sign-in",
              "Server-side scrypt password storage",
              "HttpOnly session cookie",
              "Runtime JSON account store",
            ].map((item) => (
              <div
                key={item}
                className="rounded-md border border-white/10 bg-white/[0.04] px-4 py-3"
              >
                {item}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white p-6 text-slate-950 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">Admin access</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                Use an allowed email address. The first sign-in for an allowed
                email will complete account setup.
              </p>
            </div>
            <StatusPill
              ok={authState?.auth?.hasStableSecret}
              label={authState?.auth?.hasStableSecret ? "Stable secret" : "Secret needed"}
            />
          </div>

          {emailState === EMAIL_STATE.idle ? (
            <form onSubmit={requestCode} className="mt-8 space-y-5">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  className="mt-2 w-full rounded-md border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-950 focus:ring-4 focus:ring-slate-200"
                  placeholder="name@example.com"
                />
              </label>
              {error && (
                <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                <Icon name="lock" className="h-4 w-4" />
                {busy ? "Sending code..." : "Send verification code"}
              </button>
            </form>
          ) : (
            <form onSubmit={submitCredentials} className="mt-8 space-y-5">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Verification code sent to {email}.{" "}
                {expiresAt ? `Expires ${new Date(expiresAt).toLocaleTimeString()}.` : ""}
              </div>
              {mode === "setup" && (
                <label className="block">
                  <span className="text-sm font-medium text-slate-700">
                    Username
                  </span>
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    required
                    minLength={3}
                    className="mt-2 w-full rounded-md border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-950 focus:ring-4 focus:ring-slate-200"
                    placeholder="admin"
                  />
                </label>
              )}
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={10}
                  className="mt-2 w-full rounded-md border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-950 focus:ring-4 focus:ring-slate-200"
                  placeholder="Minimum 10 characters"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">
                  Verification code
                </span>
                <input
                  inputMode="numeric"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                  minLength={6}
                  maxLength={6}
                  className="mt-2 w-full rounded-md border border-slate-300 px-4 py-3 text-sm tracking-[0.25em] outline-none transition focus:border-slate-950 focus:ring-4 focus:ring-slate-200"
                  placeholder="000000"
                />
              </label>
              {error && (
                <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </p>
              )}
              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={() => {
                    setEmailState(EMAIL_STATE.idle);
                    setCode("");
                    setPassword("");
                    setError("");
                  }}
                  className="rounded-md border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Change email
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  <Icon name="shield" className="h-4 w-4" />
                  {busy ? "Verifying..." : mode === "setup" ? "Create account" : "Sign in"}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}

function Dashboard({ user, status, refreshStatus, onLogout }) {
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState("");
  const snapshot = status?.snapshot;
  const vectorStore = status?.vectorStore;
  const runtime = status?.runtime;
  const auth = status?.auth;

  async function refreshBot(rebuildQdrant) {
    setBusyAction(rebuildQdrant ? "qdrant" : "snapshot");
    setNotice("");

    try {
      const result = await postJson("/api/admin/bot/refresh", {
        rebuildQdrant,
      });
      setNotice(
        rebuildQdrant
          ? `Snapshot refreshed and Qdrant rebuilt with ${result.qdrant?.points || 0} points.`
          : `Snapshot refreshed at ${new Date(result.generatedAt).toLocaleString()}.`
      );
      await refreshStatus();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusyAction("");
    }
  }

  const generatedAge = getGeneratedAge(snapshot?.generatedAt, status?.receivedAt);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <div className="grid min-h-screen lg:grid-cols-[280px_1fr]">
        <aside className="border-b border-slate-200 bg-slate-950 px-6 py-6 text-white lg:border-b-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-400 text-slate-950">
              <Icon name="spark" className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">REC Bot</p>
              <p className="text-xs text-slate-400">Admin Console</p>
            </div>
          </div>
          <nav className="mt-10 space-y-2 text-sm">
            {[
              ["activity", "Overview"],
              ["database", "Data refresh"],
              ["vector", "Vector index"],
              ["shield", "Access"],
            ].map(([icon, label], index) => (
              <a
                key={label}
                href={`#${label.toLowerCase().replace(" ", "-")}`}
                className={classNames(
                  "flex items-center gap-3 rounded-md px-3 py-2.5 transition hover:bg-white/10",
                  index === 0 ? "bg-white/10 text-white" : "text-slate-300"
                )}
              >
                <Icon name={icon} className="h-4 w-4" />
                {label}
              </a>
            ))}
          </nav>
          <div className="mt-10 rounded-md border border-white/10 bg-white/[0.04] p-4">
            <p className="text-sm font-medium">{user?.username || user?.email}</p>
            <p className="mt-1 text-xs text-slate-400">{user?.email}</p>
            <button
              onClick={onLogout}
              className="mt-4 w-full rounded-md border border-white/15 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/10"
            >
              Sign out
            </button>
          </div>
        </aside>

        <section className="px-5 py-6 sm:px-8 lg:px-10">
          <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500">
                Renewable Energy Conference & Expo
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-normal sm:text-4xl">
                Bot Operations
              </h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusPill ok={snapshot?.ok} label={snapshot?.ok ? "Snapshot ready" : "Snapshot missing"} />
              <StatusPill ok={vectorStore?.ok} label={getQdrantStatusLabel(vectorStore)} />
              <StatusPill ok={runtime?.smtpConfigured} label={runtime?.smtpConfigured ? "SMTP ready" : "SMTP missing"} />
            </div>
          </header>

          <div id="overview" className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon="database"
              label="Active sessions"
              value={snapshot?.counts?.sessions ?? "-"}
              detail={snapshot?.conference?.shortName || "Current REC conference"}
            />
            <MetricCard
              icon="activity"
              label="Snapshot age"
              value={generatedAge}
              detail={snapshot?.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : "No generated snapshot found"}
            />
            <MetricCard
              icon="vector"
              label="Vector points"
              value={vectorStore?.pointsCount ?? vectorStore?.vectorsCount ?? "-"}
              detail={vectorStore?.collection || "Qdrant collection"}
            />
            <MetricCard
              icon="user"
              label="Allowed admins"
              value={auth?.allowedUsers ?? "-"}
              detail={`${auth?.configuredUsers ?? 0} configured account(s)`}
            />
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <section
              id="data-refresh"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Data controls</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
                    Pull the active conference from Appwrite, regenerate the
                    local snapshot files, and optionally rebuild Qdrant for
                    semantic context.
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:min-w-56">
                  <button
                    onClick={() => refreshBot(false)}
                    disabled={Boolean(busyAction)}
                    className="flex items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                  >
                    <Icon name="refresh" className="h-4 w-4" />
                    {busyAction === "snapshot" ? "Refreshing..." : "Refresh snapshot"}
                  </button>
                  <button
                    onClick={() => refreshBot(true)}
                    disabled={Boolean(busyAction)}
                    className="flex items-center justify-center gap-2 rounded-md border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    <Icon name="vector" className="h-4 w-4" />
                    {busyAction === "qdrant" ? "Rebuilding..." : "Refresh + rebuild Qdrant"}
                  </button>
                </div>
              </div>

              {notice && (
                <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  {notice}
                </div>
              )}

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {[
                  ["Programs", snapshot?.counts?.programs],
                  ["Time blocks", snapshot?.counts?.timeBlocks],
                  ["Sponsor categories", snapshot?.counts?.sponsorCategories],
                  ["Sponsors", snapshot?.counts?.sponsors],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3"
                  >
                    <p className="text-xs font-medium uppercase text-slate-500">
                      {label}
                    </p>
                    <p className="mt-1 text-lg font-semibold">{value ?? "-"}</p>
                  </div>
                ))}
              </div>
            </section>

            <section
              id="vector-index"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-lg font-semibold">Runtime profile</h2>
              {!vectorStore?.ok && (
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  <p className="font-semibold">{vectorStore?.message}</p>
                  {vectorStore?.nextAction && (
                    <p className="mt-1 leading-6">{vectorStore.nextAction}</p>
                  )}
                </div>
              )}
              <div className="mt-4 divide-y divide-slate-100">
                {[
                  ["Qdrant collection", vectorStore?.collection],
                  ["Qdrant points", vectorStore?.pointsCount ?? "-"],
                  ["Chat model", runtime?.chatModel],
                  ["Planner model", runtime?.plannerModel],
                  ["Embedding model", runtime?.embedModel],
                  ["Planner", runtime?.plannerEnabled ? "Enabled" : "Disabled"],
                  [
                    "REC full context",
                    runtime?.recFullContextEnabled
                      ? runtime?.recFullContextMode
                      : "Disabled",
                  ],
                  [
                    "Qdrant complement",
                    runtime?.qdrantComplementEnabled
                      ? runtime?.qdrantComplementMode
                      : "Disabled",
                  ],
                  [
                    "Qdrant full context",
                    runtime?.qdrantFullContextEnabled
                      ? runtime?.qdrantFullContextMode
                      : "Disabled",
                  ],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-4 py-3">
                    <span className="text-sm text-slate-500">{label}</span>
                    <span className="text-right text-sm font-semibold text-slate-900">
                      {value || "-"}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
            <section
              id="access"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-lg font-semibold">Access list</h2>
              <div className="mt-4 space-y-3">
                {(auth?.users || []).map((adminUser) => (
                  <div
                    key={adminUser.email}
                    className="flex items-center justify-between gap-4 rounded-md border border-slate-200 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-semibold">{adminUser.email}</p>
                      <p className="text-xs text-slate-500">
                        {adminUser.username || "Not configured"}
                      </p>
                    </div>
                    <StatusPill
                      ok={adminUser.configured}
                      label={adminUser.configured ? "Configured" : "Pending"}
                    />
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Suggested live checks</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {quickChecks.map((item) => (
                  <div
                    key={item}
                    className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700"
                  >
                    {item}
                  </div>
                ))}
              </div>
              <Link
                href="/"
                className="mt-5 inline-flex items-center gap-2 rounded-md bg-emerald-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
              >
                Open public chat
              </Link>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function AdminPage() {
  const [authState, setAuthState] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  async function loadAuth() {
    const response = await fetch("/api/admin/auth/me", { cache: "no-store" });
    const data = await response.json();
    setAuthState(data);

    if (data.authenticated) {
      await loadStatus();
    }

    setLoading(false);
  }

  async function loadStatus() {
    setStatus(await fetchStatusData());
  }

  async function logout() {
    await postJson("/api/admin/auth/logout");
    setStatus(null);
    setAuthState(null);
    await loadAuth();
  }

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        const response = await fetch("/api/admin/auth/me", {
          cache: "no-store",
        });
        const data = await response.json();

        if (cancelled) return;
        setAuthState(data);

        if (data.authenticated) {
          const nextStatus = await fetchStatusData();
          if (!cancelled) setStatus(nextStatus);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    initialize();

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-950 text-white">
        <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] px-5 py-4">
          <Icon name="activity" className="h-5 w-5 animate-pulse text-emerald-300" />
          <span className="text-sm font-medium">Loading admin console...</span>
        </div>
      </main>
    );
  }

  if (!authState?.authenticated) {
    return (
      <AuthPanel
        authState={authState}
        onAuthenticated={() => loadAuth().catch(() => setLoading(false))}
      />
    );
  }

  return (
    <Dashboard
      user={authState.user}
      status={status}
      refreshStatus={loadStatus}
      onLogout={logout}
    />
  );
}
