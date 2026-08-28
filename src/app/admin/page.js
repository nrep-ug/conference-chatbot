"use client";

import {
  Activity,
  Database,
  ExternalLink,
  LockKeyhole,
  LogOut,
  Network,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  Wifi,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import BrandLogo from "../components/brand-logo";

const EMAIL_STATE = {
  idle: "idle",
  sent: "sent",
};

const quickChecks = [
  "Ask a finance recommendation question",
  "Ask about preparation across four days",
  "Ask for the REC25 programme",
  "Ask for photos from REC24",
  "Ask a published venue logistics question",
];

const knowledgeCategories = [
  ["venue", "Venue"],
  ["connectivity", "Connectivity"],
  ["transport", "Transport"],
  ["accessibility", "Accessibility"],
  ["catering", "Catering"],
  ["registration", "Registration"],
  ["safety", "Safety"],
  ["other", "Other"],
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

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
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

const iconComponents = {
  activity: Activity,
  database: Database,
  lock: LockKeyhole,
  refresh: RefreshCw,
  shield: ShieldCheck,
  spark: Sparkles,
  user: UserRound,
  vector: Network,
  plus: Plus,
  save: Save,
  trash: Trash2,
  wifi: Wifi,
};

function Icon({ name, className = "" }) {
  const Component = iconComponents[name] || Activity;
  return <Component className={className} strokeWidth={1.8} aria-hidden="true" />;
}

function StatusPill({ ok, label }) {
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold",
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-[#F3D19F] bg-[#FFF8EE] text-[#9A4A08]"
      )}
    >
      <span
        className={classNames(
          "h-1.5 w-1.5 rounded-full",
          ok ? "bg-emerald-500" : "bg-[#EFA74F]"
        )}
      />
      {label}
    </span>
  );
}

function MetricCard({ icon, label, value, detail, tone = "primary" }) {
  const iconTone =
    tone === "secondary"
      ? "bg-[#FFF2E2] text-[#B45309]"
      : tone === "light"
        ? "bg-[#E5F3F8] text-[#176F91]"
        : "bg-[#176F91] text-white";

  return (
    <article className="rounded-lg border border-[#D5E0E4] bg-white p-5 shadow-[0_1px_3px_rgba(20,38,45,0.05)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-[#617780]">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-normal text-[#14262D]">
            {value}
          </p>
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-md ${iconTone}`}>
          <Icon name={icon} className="h-5 w-5" />
        </div>
      </div>
      {detail && <p className="mt-4 text-sm leading-6 text-[#617780]">{detail}</p>}
    </article>
  );
}

function createKnowledgeItem() {
  return {
    clientId: crypto.randomUUID(),
    id: "",
    category: "venue",
    title: "",
    answer: "",
    keywordsText: "",
    isPublished: false,
  };
}

function KnowledgeEditor({ onStatusRefresh }) {
  const [conference, setConference] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState("");
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadKnowledge() {
      try {
        const response = await fetch("/api/admin/knowledge", {
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load venue knowledge.");
        if (cancelled) return;

        setConference(data.conference);
        setItems(
          (data.items || []).map((item) => ({
            ...item,
            clientId: item.id || crypto.randomUUID(),
            keywordsText: (item.keywords || []).join(", "),
          }))
        );
      } catch (error) {
        if (!cancelled) {
          setNotice(error.message);
          setHasError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadKnowledge();

    return () => {
      cancelled = true;
    };
  }, []);

  function updateItem(clientId, field, value) {
    setItems((current) =>
      current.map((item) =>
        item.clientId === clientId ? { ...item, [field]: value } : item
      )
    );
  }

  function removeItem(clientId) {
    setItems((current) => current.filter((item) => item.clientId !== clientId));
  }

  async function saveKnowledge(rebuildQdrant) {
    setBusyAction(rebuildQdrant ? "qdrant" : "save");
    setNotice("");
    setHasError(false);

    try {
      const result = await putJson("/api/admin/knowledge", {
        rebuildQdrant,
        items: items.map((item) => ({
          id: item.id,
          category: item.category,
          title: item.title,
          answer: item.answer,
          keywords: item.keywordsText
            .split(",")
            .map((keyword) => keyword.trim())
            .filter(Boolean),
          isPublished: item.isPublished,
        })),
      });

      setItems(
        result.items.map((item) => ({
          ...item,
          clientId: item.id,
          keywordsText: (item.keywords || []).join(", "),
        }))
      );
      setNotice(
        rebuildQdrant
          ? `Saved ${result.items.length} entries and rebuilt Qdrant with ${result.qdrant?.points || 0} points.`
          : `Saved ${result.items.length} entries; ${result.publishedCount} are public.`
      );
      await onStatusRefresh();
    } catch (error) {
      setNotice(error.message);
      setHasError(true);
    } finally {
      setBusyAction("");
    }
  }

  return (
    <section
      id="venue-knowledge"
      className="mt-6 rounded-lg border border-[#D5E0E4] bg-white shadow-[0_1px_3px_rgba(20,38,45,0.05)]"
    >
      <div className="flex flex-col gap-4 border-b border-[#D5E0E4] p-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Icon name="wifi" className="h-5 w-5 text-[#176F91]" />
            <h2 className="text-lg font-semibold">Venue and visitor knowledge</h2>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#617780]">
            {conference
              ? `${conference.shortName || conference.title} (${conference.year})`
              : "Active conference"}
          </p>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#9A4A08]">
            Published entries become public chatbot answers. Add only guest Wi-Fi
            details and public visitor guidance; never store staff networks,
            internal systems, or private credentials here.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setItems((current) => [...current, createKnowledgeItem()])}
          disabled={loading || Boolean(busyAction)}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-[#AFC4CC] px-4 py-2.5 text-sm font-semibold text-[#29434D] transition hover:border-[#79B5CC] hover:bg-[#F1F8FA] disabled:cursor-not-allowed disabled:text-[#9DAEB5]"
        >
          <Icon name="plus" className="h-4 w-4" />
          Add entry
        </button>
      </div>

      {loading ? (
        <div className="p-5 text-sm text-[#617780]">Loading published knowledge...</div>
      ) : (
        <div className="divide-y divide-[#D5E0E4]">
          {items.length === 0 && (
            <div className="p-5 text-sm text-[#617780]">
              No venue or visitor entries have been added.
            </div>
          )}
          {items.map((item, index) => (
            <div key={item.clientId} className="p-5">
              <div className="grid gap-4 lg:grid-cols-[180px_1fr_auto] lg:items-start">
                <label className="block">
                  <span className="text-xs font-semibold uppercase text-[#617780]">
                    Category
                  </span>
                  <select
                    value={item.category}
                    onChange={(event) =>
                      updateItem(item.clientId, "category", event.target.value)
                    }
                    className="mt-2 w-full rounded-md border border-[#B9CBD2] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#2E9ECC] focus:ring-4 focus:ring-[#E5F3F8]"
                  >
                    {knowledgeCategories.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase text-[#617780]">
                    Public topic
                  </span>
                  <input
                    value={item.title}
                    onChange={(event) =>
                      updateItem(item.clientId, "title", event.target.value)
                    }
                    maxLength={140}
                    placeholder="Guest Wi-Fi access"
                    className="mt-2 w-full rounded-md border border-[#B9CBD2] px-3 py-2.5 text-sm outline-none focus:border-[#2E9ECC] focus:ring-4 focus:ring-[#E5F3F8]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeItem(item.clientId)}
                  title={`Delete entry ${index + 1}`}
                  aria-label={`Delete entry ${index + 1}`}
                  className="mt-6 flex h-10 w-10 items-center justify-center rounded-md border border-red-200 text-red-700 transition hover:bg-red-50"
                >
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </div>
              <label className="mt-4 block">
                <span className="text-xs font-semibold uppercase text-[#617780]">
                  Public answer
                </span>
                <textarea
                  value={item.answer}
                  onChange={(event) =>
                    updateItem(item.clientId, "answer", event.target.value)
                  }
                  maxLength={3000}
                  rows={3}
                  placeholder="Connect to the public guest network..."
                  className="mt-2 w-full resize-y rounded-md border border-[#B9CBD2] px-3 py-2.5 text-sm leading-6 outline-none focus:border-[#2E9ECC] focus:ring-4 focus:ring-[#E5F3F8]"
                />
              </label>
              <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
                <label className="block">
                  <span className="text-xs font-semibold uppercase text-[#617780]">
                    Matching keywords
                  </span>
                  <input
                    value={item.keywordsText}
                    onChange={(event) =>
                      updateItem(item.clientId, "keywordsText", event.target.value)
                    }
                    placeholder="wifi, internet, password, connectivity"
                    className="mt-2 w-full rounded-md border border-[#B9CBD2] px-3 py-2.5 text-sm outline-none focus:border-[#2E9ECC] focus:ring-4 focus:ring-[#E5F3F8]"
                  />
                </label>
                <label className="flex h-11 items-center gap-3 rounded-md border border-[#B9CBD2] px-4 text-sm font-semibold text-[#29434D]">
                  <input
                    type="checkbox"
                    checked={item.isPublished}
                    onChange={(event) =>
                      updateItem(item.clientId, "isPublished", event.target.checked)
                    }
                    className="h-4 w-4 accent-[#176F91]"
                  />
                  Published
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-[#D5E0E4] bg-[#F7F9FA] p-5 sm:flex-row sm:items-center sm:justify-between">
        <div
          className={classNames(
            "text-sm",
            hasError ? "text-red-700" : "text-[#526B75]"
          )}
        >
          {notice || `${items.filter((item) => item.isPublished).length} public entr${
            items.filter((item) => item.isPublished).length === 1 ? "y" : "ies"
          }`}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => saveKnowledge(false)}
            disabled={loading || Boolean(busyAction)}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-[#176F91] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#0B5E78] disabled:cursor-not-allowed disabled:bg-[#AEC0C7]"
          >
            <Icon name="save" className="h-4 w-4" />
            {busyAction === "save" ? "Saving..." : "Save changes"}
          </button>
          <button
            type="button"
            onClick={() => saveKnowledge(true)}
            disabled={loading || Boolean(busyAction)}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-[#AFC4CC] bg-white px-4 py-2.5 text-sm font-semibold text-[#29434D] transition hover:border-[#79B5CC] hover:bg-[#F1F8FA] disabled:cursor-not-allowed disabled:text-[#9DAEB5]"
          >
            <Icon name="vector" className="h-4 w-4" />
            {busyAction === "qdrant" ? "Rebuilding..." : "Save + rebuild Qdrant"}
          </button>
        </div>
      </div>
    </section>
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
    <main className="min-h-screen bg-[#F4F7F8] text-[#14262D]">
      <div className="grid min-h-screen lg:grid-cols-[minmax(360px,0.9fr)_minmax(520px,1.1fr)]">
        <section className="flex flex-col border-t-4 border-[#EFA74F] bg-[#0B5E78] px-6 py-5 text-white sm:px-10 lg:px-14 lg:py-10">
          <div className="flex items-center gap-3">
            <BrandLogo
              className="h-14 w-14 rounded-md border border-white/25"
              priority
            />
            <div>
              <p className="text-lg font-semibold">NREP</p>
              <p className="text-xs text-[#B9DCE9]">Conference intelligence</p>
            </div>
          </div>

          <div className="max-w-xl py-7 lg:my-auto lg:py-16">
            <p className="text-xs font-semibold uppercase text-[#F5C078]">
              Protected administration
            </p>
            <h1 className="mt-3 text-2xl font-semibold leading-tight sm:text-3xl lg:mt-4 lg:text-4xl">
              REC Assistant Operations
            </h1>
            <p className="mt-4 text-sm leading-6 text-[#D5EBF3] sm:text-base sm:leading-7 lg:mt-5 lg:leading-8">
              Manage conference data, visitor guidance, retrieval services, and
              the health of the public assistant from one controlled workspace.
            </p>
            <div className="mt-8 hidden space-y-4 border-t border-white/15 pt-6 lg:block">
              {[
                "Email verification required for every sign-in",
                "Server-side password derivation and secure sessions",
                "Restricted access for approved administrators",
              ].map((item) => (
                <div key={item} className="flex items-start gap-3 text-sm text-[#D5EBF3]">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#F5C078]" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="hidden text-xs text-[#9DCBDB] lg:block">
            Renewable Energy Conference & Expo
          </p>
        </section>

        <section className="grid place-items-center px-4 py-10 sm:px-8 lg:px-12">
          <div className="w-full max-w-md rounded-lg border border-[#D5E0E4] border-t-4 border-t-[#2E9ECC] bg-white p-6 shadow-[0_18px_50px_rgba(20,38,45,0.10)] sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">Admin access</h2>
                <p className="mt-2 text-sm leading-6 text-[#617780]">
                  Continue with an approved email address. New administrators
                  complete their account setup after email verification.
                </p>
              </div>
              <StatusPill
                ok={authState?.auth?.hasStableSecret}
                label={authState?.auth?.hasStableSecret ? "Protected" : "Setup needed"}
              />
            </div>

            {emailState === EMAIL_STATE.idle ? (
              <form onSubmit={requestCode} className="mt-8 space-y-5">
                <label className="block">
                  <span className="text-sm font-medium text-[#29434D]">Email address</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    autoComplete="email"
                    className="mt-2 w-full rounded-md border border-[#B9CBD2] px-4 py-3 text-sm outline-none transition focus:border-[#2E9ECC] focus:ring-4 focus:ring-[#E5F3F8]"
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
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-[#176F91] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#0B5E78] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2E9ECC] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#AEC0C7]"
                >
                  <LockKeyhole className="h-4 w-4" />
                  {busy ? "Sending code..." : "Send verification code"}
                </button>
              </form>
            ) : (
              <form onSubmit={submitCredentials} className="mt-8 space-y-5">
                <div className="rounded-md border border-[#B7D9E6] bg-[#F1F8FA] px-4 py-3 text-sm text-[#0B5E78]">
                  Verification code sent to {email}.{" "}
                  {expiresAt ? `Expires ${new Date(expiresAt).toLocaleTimeString()}.` : ""}
                </div>
                {mode === "setup" && (
                  <label className="block">
                    <span className="text-sm font-medium text-[#29434D]">
                      Username
                    </span>
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      required
                      minLength={3}
                      autoComplete="username"
                      className="mt-2 w-full rounded-md border border-[#B9CBD2] px-4 py-3 text-sm outline-none transition focus:border-[#2E9ECC] focus:ring-4 focus:ring-[#E5F3F8]"
                      placeholder="admin"
                    />
                  </label>
                )}
                <label className="block">
                  <span className="text-sm font-medium text-[#29434D]">Password</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    minLength={10}
                    autoComplete={mode === "setup" ? "new-password" : "current-password"}
                    className="mt-2 w-full rounded-md border border-[#B9CBD2] px-4 py-3 text-sm outline-none transition focus:border-[#2E9ECC] focus:ring-4 focus:ring-[#E5F3F8]"
                    placeholder="Minimum 10 characters"
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-[#29434D]">
                    Verification code
                  </span>
                  <input
                    inputMode="numeric"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    required
                    minLength={6}
                    maxLength={6}
                    autoComplete="one-time-code"
                    className="mt-2 w-full rounded-md border border-[#B9CBD2] px-4 py-3 text-sm tracking-[0.25em] outline-none transition focus:border-[#2E9ECC] focus:ring-4 focus:ring-[#E5F3F8]"
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
                    className="rounded-md border border-[#AFC4CC] px-4 py-3 text-sm font-semibold text-[#29434D] transition hover:bg-[#F1F8FA]"
                  >
                    Change email
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-[#176F91] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#0B5E78] disabled:cursor-not-allowed disabled:bg-[#AEC0C7]"
                  >
                    <ShieldCheck className="h-4 w-4" />
                    {busy ? "Verifying..." : mode === "setup" ? "Create account" : "Sign in"}
                  </button>
                </div>
              </form>
            )}
          </div>
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
    <main className="min-h-screen bg-[#F4F7F8] text-[#14262D]">
      <div className="grid min-h-screen lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-t-4 border-[#EFA74F] bg-[#0B5E78] px-4 py-4 text-white lg:sticky lg:top-0 lg:h-screen lg:px-5 lg:py-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <BrandLogo
                className="h-11 w-11 rounded-md border border-white/25"
                priority
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">REC Assistant</p>
                <p className="text-xs text-[#B9DCE9]">Administration</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              title="Sign out"
              aria-label="Sign out"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/20 text-[#D5EBF3] transition hover:bg-white/10 lg:hidden"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
          <nav className="mt-5 flex gap-2 overflow-x-auto pb-1 text-sm lg:mt-10 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0">
            {[
              ["activity", "Overview"],
              ["database", "Data refresh"],
              ["wifi", "Venue knowledge"],
              ["vector", "Vector index"],
              ["shield", "Access"],
            ].map(([icon, label], index) => (
              <a
                key={label}
                href={`#${label.toLowerCase().replace(" ", "-")}`}
                className={classNames(
                  "flex shrink-0 items-center gap-2 rounded-md px-3 py-2.5 transition hover:bg-white/10 lg:w-full lg:gap-3",
                  index === 0
                    ? "bg-white/12 text-white"
                    : "text-[#CBE7F2]"
                )}
              >
                <Icon name={icon} className="h-4 w-4" />
                {label}
              </a>
            ))}
          </nav>
          <div className="mt-10 hidden rounded-md border border-white/15 bg-white/[0.05] p-4 lg:block">
            <p className="text-sm font-medium">{user?.username || user?.email}</p>
            <p className="mt-1 break-all text-xs text-[#B9DCE9]">{user?.email}</p>
            <button
              onClick={onLogout}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-md border border-white/20 px-3 py-2 text-sm font-semibold text-[#E4F2F7] transition hover:bg-white/10"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </aside>

        <section className="min-w-0 px-4 py-6 sm:px-7 lg:px-9 xl:px-10">
          <header className="flex flex-col gap-4 border-b border-[#D5E0E4] pb-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-medium text-[#176F91]">
                Renewable Energy Conference & Expo
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-normal text-[#14262D] sm:text-4xl">
                Assistant Operations
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
              tone="primary"
            />
            <MetricCard
              icon="activity"
              label="Snapshot age"
              value={generatedAge}
              detail={snapshot?.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : "No generated snapshot found"}
              tone="secondary"
            />
            <MetricCard
              icon="vector"
              label="Vector points"
              value={vectorStore?.pointsCount ?? vectorStore?.vectorsCount ?? "-"}
              detail={vectorStore?.collection || "Qdrant collection"}
              tone="light"
            />
            <MetricCard
              icon="user"
              label="Previous editions"
              value={snapshot?.counts?.previousConferences ?? "-"}
              detail={`${snapshot?.counts?.historicalMediaItems ?? 0} media, ${snapshot?.counts?.historicalReports ?? 0} reports`}
              tone="secondary"
            />
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <section
              id="data-refresh"
              className="rounded-lg border border-[#D5E0E4] bg-white p-5 shadow-[0_1px_3px_rgba(20,38,45,0.05)]"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Data controls</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-[#617780]">
                    Pull all public REC editions from Appwrite, regenerate the
                    active and historical snapshot, and optionally rebuild
                    Qdrant for semantic context.
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:min-w-56">
                  <button
                    onClick={() => refreshBot(false)}
                    disabled={Boolean(busyAction)}
                    className="flex items-center justify-center gap-2 rounded-md bg-[#176F91] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#0B5E78] disabled:cursor-not-allowed disabled:bg-[#AEC0C7]"
                  >
                    <Icon name="refresh" className="h-4 w-4" />
                    {busyAction === "snapshot" ? "Refreshing..." : "Refresh snapshot"}
                  </button>
                  <button
                    onClick={() => refreshBot(true)}
                    disabled={Boolean(busyAction)}
                    className="flex items-center justify-center gap-2 rounded-md border border-[#AFC4CC] px-4 py-3 text-sm font-semibold text-[#29434D] transition hover:border-[#79B5CC] hover:bg-[#F1F8FA] disabled:cursor-not-allowed disabled:text-[#9DAEB5]"
                  >
                    <Icon name="vector" className="h-4 w-4" />
                    {busyAction === "qdrant" ? "Rebuilding..." : "Refresh + rebuild Qdrant"}
                  </button>
                </div>
              </div>

              {notice && (
                <div className="mt-4 rounded-md border border-[#B7D9E6] bg-[#F1F8FA] px-4 py-3 text-sm text-[#29434D]">
                  {notice}
                </div>
              )}

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {[
                  ["Programs", snapshot?.counts?.programs],
                  ["Time blocks", snapshot?.counts?.timeBlocks],
                  ["Sponsor categories", snapshot?.counts?.sponsorCategories],
                  ["Sponsors", snapshot?.counts?.sponsors],
                  ["Venue knowledge", snapshot?.counts?.operationalInfo],
                  ["Historical media", snapshot?.counts?.historicalMediaItems],
                  [
                    "Conference reports",
                    (snapshot?.counts?.reports ?? 0) +
                      (snapshot?.counts?.historicalReports ?? 0),
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-md border border-[#D5E0E4] bg-[#F7F9FA] px-4 py-3"
                  >
                    <p className="text-xs font-medium uppercase text-[#617780]">
                      {label}
                    </p>
                    <p className="mt-1 text-lg font-semibold">{value ?? "-"}</p>
                  </div>
                ))}
              </div>
            </section>

            <section
              id="vector-index"
              className="rounded-lg border border-[#D5E0E4] bg-white p-5 shadow-[0_1px_3px_rgba(20,38,45,0.05)]"
            >
              <h2 className="text-lg font-semibold">Runtime profile</h2>
              {!vectorStore?.ok && (
                <div className="mt-4 rounded-md border border-[#F3D19F] bg-[#FFF8EE] px-4 py-3 text-sm text-[#8A450B]">
                  <p className="font-semibold">{vectorStore?.message}</p>
                  {vectorStore?.nextAction && (
                    <p className="mt-1 leading-6">{vectorStore.nextAction}</p>
                  )}
                </div>
              )}
              <div className="mt-4 divide-y divide-[#E8EEF0]">
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
                    <span className="text-sm text-[#617780]">{label}</span>
                    <span className="text-right text-sm font-semibold text-[#203A44]">
                      {value || "-"}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <KnowledgeEditor onStatusRefresh={refreshStatus} />

          <div className="mt-6 grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
            <section
              id="access"
              className="rounded-lg border border-[#D5E0E4] bg-white p-5 shadow-[0_1px_3px_rgba(20,38,45,0.05)]"
            >
              <h2 className="text-lg font-semibold">Access list</h2>
              <div className="mt-4 space-y-3">
                {(auth?.users || []).map((adminUser) => (
                  <div
                    key={adminUser.email}
                    className="flex items-center justify-between gap-4 rounded-md border border-[#D5E0E4] px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-semibold">{adminUser.email}</p>
                      <p className="text-xs text-[#617780]">
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

            <section className="rounded-lg border border-[#D5E0E4] bg-white p-5 shadow-[0_1px_3px_rgba(20,38,45,0.05)]">
              <h2 className="text-lg font-semibold">Suggested live checks</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {quickChecks.map((item) => (
                  <div
                    key={item}
                    className="rounded-md border border-[#D5E0E4] bg-[#F7F9FA] px-4 py-3 text-sm text-[#3B555F]"
                  >
                    {item}
                  </div>
                ))}
              </div>
              <Link
                href="/"
                className="mt-5 inline-flex items-center gap-2 rounded-md bg-[#176F91] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#0B5E78]"
              >
                Open public chat
                <ExternalLink className="h-4 w-4" />
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
      <main className="grid min-h-screen place-items-center bg-[#0B5E78] text-white">
        <div className="flex items-center gap-4 rounded-lg border border-white/15 bg-white/[0.06] px-5 py-4">
          <BrandLogo className="h-10 w-10 rounded-md border border-white/20" priority />
          <div>
            <span className="block text-sm font-medium">Loading administration</span>
            <span className="mt-1 block text-xs text-[#B9DCE9]">Checking your secure session</span>
          </div>
          <Icon name="activity" className="ml-2 h-5 w-5 animate-pulse text-[#F5C078]" />
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
