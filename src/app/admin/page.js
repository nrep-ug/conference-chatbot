"use client";

import {
  Activity,
  ArrowUpRight,
  ChevronRight,
  Clock3,
  Database,
  ExternalLink,
  LockKeyhole,
  KeyRound,
  LogOut,
  Network,
  Plus,
  RefreshCw,
  Search,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  Wifi,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  CONFERENCE_KNOWLEDGE_LIMITS,
  formatConferenceKnowledgeValidationError,
  normalizeConferenceKnowledgeKeywords,
  validateConferenceKnowledgeItemForPublishing,
  validateConferenceKnowledgeItems,
} from "@/lib/conference-knowledge-validation";
import BrandLogo from "../components/brand-logo";
import Access from "./access";
import Integrations, { AdminDialog, integrationRequest } from "./integrations";
import "./admin.css";

const EMAIL_STATE = {
  idle: "idle",
  sent: "sent",
};

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
  if (vectorStore?.issue === "missing_collection")
    return "Qdrant collection missing";
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
    const error = new Error(data.error || "The request failed.");
    error.details = data;
    throw error;
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
  return (
    <Component className={className} strokeWidth={1.8} aria-hidden="true" />
  );
}

function StatusPill({ ok, label }) {
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold",
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-[#F3D19F] bg-[#FFF8EE] text-[#9A4A08]",
      )}
    >
      <span
        className={classNames(
          "h-1.5 w-1.5 rounded-full",
          ok ? "bg-emerald-500" : "bg-[#EFA74F]",
        )}
      />
      {label}
    </span>
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

function serializeKnowledgeItem(item) {
  return {
    id: item.id,
    category: item.category,
    title: item.title,
    answer: item.answer,
    keywords: normalizeConferenceKnowledgeKeywords(item.keywordsText),
    isPublished: item.isPublished,
  };
}

function serializeKnowledgeItems(items) {
  return items.map(serializeKnowledgeItem);
}

function getClientFieldName(field) {
  return field === "keywords" ? "keywordsText" : field;
}

function mapKnowledgeFieldErrors(issues, items) {
  const errors = {};

  for (const issue of issues || []) {
    if (!Number.isInteger(issue.index) || !items[issue.index]) continue;

    const clientId = items[issue.index].clientId;
    const field = getClientFieldName(issue.field);
    errors[clientId] ||= {};
    errors[clientId][field] ||= issue.message;
  }

  return errors;
}

function focusFirstKnowledgeError(issues) {
  const issue = (issues || []).find(
    (candidate) =>
      Number.isInteger(candidate.index) &&
      ["category", "title", "answer", "keywords", "isPublished"].includes(
        candidate.field,
      ),
  );
  if (!issue) return;

  const field = getClientFieldName(issue.field);
  requestAnimationFrame(() => {
    const element = document.getElementById(
      `knowledge-${issue.index}-${field}`,
    );
    const section = element?.closest("details");
    if (section) section.open = true;
    element?.focus();
  });
}

function canPublishKnowledgeItem(item) {
  return validateConferenceKnowledgeItemForPublishing(
    serializeKnowledgeItem(item),
  ).valid;
}

function KnowledgeEditor({ onStatusRefresh }) {
  const [conference, setConference] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState("");
  const [hasError, setHasError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadKnowledge() {
      try {
        const response = await fetch("/api/admin/knowledge", {
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Unable to load venue knowledge.");
        if (cancelled) return;

        setConference(data.conference);
        const loadedItems = (data.items || []).map((item) => ({
          ...item,
          clientId: item.id || crypto.randomUUID(),
          keywordsText: (item.keywords || []).join(", "),
        }));
        const validation = validateConferenceKnowledgeItems(
          serializeKnowledgeItems(loadedItems),
        );

        setItems(loadedItems);
        setFieldErrors(mapKnowledgeFieldErrors(validation.issues, loadedItems));
        if (!validation.valid) {
          setNotice(
            formatConferenceKnowledgeValidationError(validation.issues),
          );
          setHasError(true);
        }
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
        item.clientId === clientId ? { ...item, [field]: value } : item,
      ),
    );
    setFieldErrors((current) => {
      if (!current[clientId]?.[field]) return current;

      const next = { ...current };
      const entryErrors = { ...next[clientId] };
      delete entryErrors[field];

      if (Object.keys(entryErrors).length === 0) delete next[clientId];
      else next[clientId] = entryErrors;

      return next;
    });
    setNotice("");
    setHasError(false);
  }

  function removeItem(clientId) {
    setItems((current) => current.filter((item) => item.clientId !== clientId));
    setFieldErrors((current) => {
      if (!current[clientId]) return current;
      const next = { ...current };
      delete next[clientId];
      return next;
    });
    setNotice("");
    setHasError(false);
  }

  function togglePublished(clientId, shouldPublish) {
    if (!shouldPublish) {
      updateItem(clientId, "isPublished", false);
      return;
    }

    const itemIndex = items.findIndex((item) => item.clientId === clientId);
    if (itemIndex < 0) return;

    const nextItems = items.map((item, index) =>
      index === itemIndex ? { ...item, isPublished: true } : item,
    );
    const validation = validateConferenceKnowledgeItems(
      serializeKnowledgeItems(nextItems),
    );
    const itemIssues = validation.issues.filter(
      (issue) => issue.index === itemIndex,
    );

    if (itemIssues.length > 0) {
      setFieldErrors((current) => ({
        ...current,
        ...mapKnowledgeFieldErrors(itemIssues, nextItems),
      }));
      setNotice(formatConferenceKnowledgeValidationError(itemIssues));
      setHasError(true);
      focusFirstKnowledgeError(itemIssues);
      return;
    }

    updateItem(clientId, "isPublished", true);
  }

  async function saveKnowledge(rebuildQdrant) {
    const payloadItems = serializeKnowledgeItems(items);
    const validation = validateConferenceKnowledgeItems(payloadItems);

    if (!validation.valid) {
      setSearch("");
      setFieldErrors(mapKnowledgeFieldErrors(validation.issues, items));
      setNotice(formatConferenceKnowledgeValidationError(validation.issues));
      setHasError(true);
      focusFirstKnowledgeError(validation.issues);
      return;
    }

    setBusyAction(rebuildQdrant ? "qdrant" : "save");
    setNotice("");
    setHasError(false);
    setFieldErrors({});

    try {
      const result = await putJson("/api/admin/knowledge", {
        rebuildQdrant,
        items: payloadItems,
      });

      setItems(
        result.items.map((item) => ({
          ...item,
          clientId: item.id,
          keywordsText: (item.keywords || []).join(", "),
        })),
      );
      setFieldErrors({});
      setNotice(
        rebuildQdrant
          ? `Saved ${result.items.length} entries and rebuilt Qdrant with ${result.qdrant?.points || 0} points.`
          : `Saved ${result.items.length} entries; ${result.publishedCount} are public.`,
      );
      await onStatusRefresh();
    } catch (error) {
      const serverIssues = Array.isArray(error.details?.issues)
        ? error.details.issues
        : [];
      if (serverIssues.length > 0) {
        setFieldErrors(mapKnowledgeFieldErrors(serverIssues, items));
        focusFirstKnowledgeError(serverIssues);
      }
      setNotice(error.message);
      setHasError(true);
    } finally {
      setBusyAction("");
    }
  }

  const publishedCount = items.filter(
    (item) => item.isPublished && canPublishKnowledgeItem(item),
  ).length;

  return (
    <section
      id="venue-knowledge"
      className="mt-6 rounded-lg border border-[#D5E0E4] bg-white shadow-[0_1px_3px_rgba(20,38,45,0.05)]"
    >
      <div className="flex flex-col gap-4 border-b border-[#D5E0E4] p-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Icon name="wifi" className="h-5 w-5 text-[#176F91]" />
            <h2 className="text-lg font-semibold">
              Venue and visitor knowledge
            </h2>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#617780]">
            {conference
              ? `${conference.shortName || conference.title} (${conference.year})`
              : "Active conference"}
          </p>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#9A4A08]">
            Published entries become public chatbot answers. Add only guest
            Wi-Fi details and public visitor guidance; never store staff
            networks, internal systems, or private credentials here.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setSearch("");
            setItems((current) => [...current, createKnowledgeItem()]);
          }}
          disabled={
            loading ||
            Boolean(busyAction) ||
            items.length >= CONFERENCE_KNOWLEDGE_LIMITS.items
          }
          title={
            items.length >= CONFERENCE_KNOWLEDGE_LIMITS.items
              ? `A conference can have at most ${CONFERENCE_KNOWLEDGE_LIMITS.items} entries.`
              : "Add a venue or visitor knowledge entry"
          }
          className="inline-flex items-center justify-center gap-2 rounded-md border border-[#AFC4CC] px-4 py-2.5 text-sm font-semibold text-[#29434D] transition hover:border-[#79B5CC] hover:bg-[#F1F8FA] disabled:cursor-not-allowed disabled:text-[#9DAEB5]"
        >
          <Icon name="plus" className="h-4 w-4" />
          Add entry
        </button>
      </div>

      <div className="admin-toolbar">
        <label className="admin-search">
          <Search size={17} />
          <input
            aria-label="Search knowledge entries"
            placeholder="Search visitor knowledge"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <span className="admin-muted">{items.length} entries</span>
      </div>
      {loading ? (
        <div className="p-5 text-sm text-[#617780]">
          Loading published knowledge...
        </div>
      ) : (
        <div className="divide-y divide-[#D5E0E4]">
          {items.length === 0 && (
            <div className="p-5 text-sm text-[#617780]">
              No venue or visitor entries have been added.
            </div>
          )}
          {items.map((item, index) => (
            <details
              key={item.clientId}
              className="admin-knowledge-entry"
              open={!item.id || Boolean(fieldErrors[item.clientId])}
              hidden={
                !(item.title + " " + item.answer + " " + item.category)
                  .toLowerCase()
                  .includes(search.toLowerCase())
              }
            >
              <summary>
                <Wifi size={17} />
                <strong>{item.title || "Untitled entry"}</strong>
                <StatusPill
                  ok={item.isPublished}
                  label={item.isPublished ? "Published" : "Draft"}
                />
                <ChevronRight size={16} />
              </summary>
              <div className="p-5">
                <div className="grid gap-4 lg:grid-cols-[180px_1fr_auto] lg:items-start">
                  <label className="block">
                    <span className="text-xs font-semibold uppercase text-[#617780]">
                      Category
                    </span>
                    <select
                      id={`knowledge-${index}-category`}
                      value={item.category}
                      onChange={(event) =>
                        updateItem(
                          item.clientId,
                          "category",
                          event.target.value,
                        )
                      }
                      aria-invalid={Boolean(
                        fieldErrors[item.clientId]?.category,
                      )}
                      aria-describedby={
                        fieldErrors[item.clientId]?.category
                          ? `knowledge-${index}-category-error`
                          : undefined
                      }
                      className={classNames(
                        "mt-2 w-full rounded-md border bg-white px-3 py-2.5 text-sm outline-none focus:ring-4",
                        fieldErrors[item.clientId]?.category
                          ? "border-red-500 focus:border-red-600 focus:ring-red-100"
                          : "border-[#B9CBD2] focus:border-[#2E9ECC] focus:ring-[#E5F3F8]",
                      )}
                    >
                      {knowledgeCategories.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {fieldErrors[item.clientId]?.category && (
                      <span
                        id={`knowledge-${index}-category-error`}
                        className="mt-1.5 block text-xs font-medium text-red-700"
                      >
                        {fieldErrors[item.clientId].category}
                      </span>
                    )}
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold uppercase text-[#617780]">
                      Public topic
                    </span>
                    <input
                      id={`knowledge-${index}-title`}
                      value={item.title}
                      onChange={(event) =>
                        updateItem(item.clientId, "title", event.target.value)
                      }
                      maxLength={CONFERENCE_KNOWLEDGE_LIMITS.title}
                      required={item.isPublished}
                      aria-invalid={Boolean(fieldErrors[item.clientId]?.title)}
                      aria-describedby={
                        fieldErrors[item.clientId]?.title
                          ? `knowledge-${index}-title-error`
                          : undefined
                      }
                      placeholder="Guest Wi-Fi access"
                      className={classNames(
                        "mt-2 w-full rounded-md border px-3 py-2.5 text-sm outline-none focus:ring-4",
                        fieldErrors[item.clientId]?.title
                          ? "border-red-500 focus:border-red-600 focus:ring-red-100"
                          : "border-[#B9CBD2] focus:border-[#2E9ECC] focus:ring-[#E5F3F8]",
                      )}
                    />
                    {fieldErrors[item.clientId]?.title && (
                      <span
                        id={`knowledge-${index}-title-error`}
                        className="mt-1.5 block text-xs font-medium text-red-700"
                      >
                        {fieldErrors[item.clientId].title}
                      </span>
                    )}
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
                    id={`knowledge-${index}-answer`}
                    value={item.answer}
                    onChange={(event) =>
                      updateItem(item.clientId, "answer", event.target.value)
                    }
                    maxLength={CONFERENCE_KNOWLEDGE_LIMITS.answer}
                    required={item.isPublished}
                    aria-invalid={Boolean(fieldErrors[item.clientId]?.answer)}
                    aria-describedby={
                      fieldErrors[item.clientId]?.answer
                        ? `knowledge-${index}-answer-error`
                        : undefined
                    }
                    rows={3}
                    placeholder="Connect to the public guest network..."
                    className={classNames(
                      "mt-2 w-full resize-y rounded-md border px-3 py-2.5 text-sm leading-6 outline-none focus:ring-4",
                      fieldErrors[item.clientId]?.answer
                        ? "border-red-500 focus:border-red-600 focus:ring-red-100"
                        : "border-[#B9CBD2] focus:border-[#2E9ECC] focus:ring-[#E5F3F8]",
                    )}
                  />
                  {fieldErrors[item.clientId]?.answer && (
                    <span
                      id={`knowledge-${index}-answer-error`}
                      className="mt-1.5 block text-xs font-medium text-red-700"
                    >
                      {fieldErrors[item.clientId].answer}
                    </span>
                  )}
                </label>
                <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
                  <label className="block">
                    <span className="text-xs font-semibold uppercase text-[#617780]">
                      Matching keywords
                    </span>
                    <input
                      id={`knowledge-${index}-keywordsText`}
                      value={item.keywordsText}
                      onChange={(event) =>
                        updateItem(
                          item.clientId,
                          "keywordsText",
                          event.target.value,
                        )
                      }
                      required={item.isPublished}
                      aria-invalid={Boolean(
                        fieldErrors[item.clientId]?.keywordsText,
                      )}
                      aria-describedby={
                        fieldErrors[item.clientId]?.keywordsText
                          ? `knowledge-${index}-keywordsText-error`
                          : undefined
                      }
                      placeholder="wifi, internet, password, connectivity"
                      className={classNames(
                        "mt-2 w-full rounded-md border px-3 py-2.5 text-sm outline-none focus:ring-4",
                        fieldErrors[item.clientId]?.keywordsText
                          ? "border-red-500 focus:border-red-600 focus:ring-red-100"
                          : "border-[#B9CBD2] focus:border-[#2E9ECC] focus:ring-[#E5F3F8]",
                      )}
                    />
                    {fieldErrors[item.clientId]?.keywordsText && (
                      <span
                        id={`knowledge-${index}-keywordsText-error`}
                        className="mt-1.5 block text-xs font-medium text-red-700"
                      >
                        {fieldErrors[item.clientId].keywordsText}
                      </span>
                    )}
                  </label>
                  <div>
                    <label
                      className={classNames(
                        "flex h-11 items-center gap-3 rounded-md border px-4 text-sm font-semibold text-[#29434D]",
                        fieldErrors[item.clientId]?.isPublished
                          ? "border-red-500 bg-red-50"
                          : "border-[#B9CBD2]",
                      )}
                    >
                      <input
                        id={`knowledge-${index}-isPublished`}
                        type="checkbox"
                        checked={item.isPublished}
                        onChange={(event) =>
                          togglePublished(item.clientId, event.target.checked)
                        }
                        aria-invalid={Boolean(
                          fieldErrors[item.clientId]?.isPublished,
                        )}
                        className="h-4 w-4 accent-[#176F91]"
                      />
                      Published
                    </label>
                    {!item.isPublished && !canPublishKnowledgeItem(item) && (
                      <p className="mt-1.5 max-w-48 text-xs leading-5 text-[#617780]">
                        Complete the topic, answer, and keywords to publish.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-[#D5E0E4] bg-[#F7F9FA] p-5 sm:flex-row sm:items-center sm:justify-between">
        <div
          role={hasError ? "alert" : "status"}
          aria-live="polite"
          className={classNames(
            "text-sm",
            hasError ? "text-red-700" : "text-[#526B75]",
          )}
        >
          {notice ||
            `${publishedCount} public entr${publishedCount === 1 ? "y" : "ies"}`}
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
            {busyAction === "qdrant"
              ? "Rebuilding..."
              : "Save + rebuild Qdrant"}
          </button>
        </div>
      </div>
    </section>
  );
}

function AuthPanel({ onAuthenticated }) {
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
    <main className="admin-auth">
      <header className="admin-auth-brand">
        <BrandLogo
          className="h-12 w-12 rounded-md border border-[#e1e7ea]"
          priority
        />
        <div>
          <strong>REC Assistant</strong>
          <span>NREP Administration</span>
        </div>
      </header>
      <section className="admin-auth-main">
        <div className="admin-auth-form">
          <span className="admin-badge muted">
            <ShieldCheck size={14} />
            Restricted access
          </span>
          <h1>
            {emailState === EMAIL_STATE.idle
              ? "Sign in to your workspace"
              : mode === "setup"
                ? "Set up your account"
                : "Verify your identity"}
          </h1>
          <p>
            {emailState === EMAIL_STATE.idle
              ? "An approved account email is required."
              : "Enter your password and email verification code."}
          </p>
          {emailState === EMAIL_STATE.idle ? (
            <form onSubmit={requestCode} className="mt-8 space-y-5">
              <label className="block">
                <span className="text-sm font-medium text-[#29434D]">
                  Email address
                </span>
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
                {expiresAt
                  ? `Expires ${new Date(expiresAt).toLocaleTimeString()}.`
                  : ""}
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
                <span className="text-sm font-medium text-[#29434D]">
                  Password
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={10}
                  autoComplete={
                    mode === "setup" ? "new-password" : "current-password"
                  }
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
                  {busy
                    ? "Verifying..."
                    : mode === "setup"
                      ? "Create account"
                      : "Sign in"}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
      <footer>Renewable Energy Conference & Expo</footer>
    </main>
  );
}

function Dashboard({ user, status, refreshStatus, onLogout }) {
  const canManage = user?.role === "owner" || user?.role === "admin";
  const [view, setView] = useState("overview");
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState("");
  const [registry, setRegistry] = useState(null);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [registryError, setRegistryError] = useState("");
  const [confirmRefresh, setConfirmRefresh] = useState(null);
  const snapshot = status?.snapshot,
    vectorStore = status?.vectorStore,
    runtime = status?.runtime;
  const navigation = useMemo(() => [
    ["overview", "Overview", Activity],
    ["knowledge", "Visitor knowledge", Wifi],
    ["runtime", "Data & runtime", Database],
    ["integrations", "API integrations", KeyRound],
    ["access", "Team access", ShieldCheck],
  ].filter(([id]) => canManage || id !== "knowledge"), [canManage]);
  async function loadRegistry() {
    setRegistryLoading(true);
    setRegistryError("");
    try {
      setRegistry({ ...(await integrationRequest()), receivedAt: Date.now() });
    } catch (error) {
      setRegistryError(error.message);
    } finally {
      setRegistryLoading(false);
    }
  }
  useEffect(() => {
    let cancelled = false;
    integrationRequest()
      .then((data) => {
        if (!cancelled) setRegistry({ ...data, receivedAt: Date.now() });
      })
      .catch((error) => {
        if (!cancelled) setRegistryError(error.message);
      })
      .finally(() => {
        if (!cancelled) setRegistryLoading(false);
      });
    const updateView = () => {
      const name = location.hash.slice(1);
      setView(navigation.some(([id]) => id === name) ? name : "overview");
    };
    updateView();
    window.addEventListener("hashchange", updateView);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", updateView);
    };
  }, [navigation]);
  async function refreshBot(rebuildQdrant) {
    setBusyAction("refresh");
    setNotice("");
    try {
      const result = await postJson("/api/admin/bot/refresh", {
        rebuildQdrant,
      });
      setNotice(
        rebuildQdrant
          ? "Snapshot refreshed and vector index rebuilt."
          : "Conference snapshot refreshed.",
      );
      if (!result.generatedAt)
        setNotice("Refresh finished. Check the snapshot status.");
      await refreshStatus();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusyAction("");
      setConfirmRefresh(null);
    }
  }
  async function checkServices() {
    setBusyAction("status");
    setNotice("");
    try {
      await refreshStatus();
      await loadRegistry();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusyAction("");
    }
  }
  const integrationItems = registry?.integrations || [];
  const totals = integrationItems.reduce(
    (sum, item) => ({
      requests: sum.requests + item.usage.admitted,
      completed: sum.completed + item.usage.completed,
      failed: sum.failed + item.usage.failed,
      degraded: sum.degraded + item.usage.degraded,
      duration: sum.duration + item.usage.duration_ms,
      finished:
        sum.finished +
        item.usage.completed +
        item.usage.failed +
        item.usage.cancelled +
        item.usage.degraded,
    }),
    {
      requests: 0,
      completed: 0,
      failed: 0,
      degraded: 0,
      duration: 0,
      finished: 0,
    },
  );
  const active = integrationItems.filter(
    (item) =>
      !item.revokedAt &&
      item.enabled &&
      Date.parse(item.expiresAt) > registry.receivedAt,
  ).length;
  const services = [
    {
      name: "Conference snapshot",
      detail: snapshot?.conference?.shortName || "Appwrite public data",
      ok: snapshot?.ok,
    },
    {
      name: "Vector index",
      detail: getQdrantStatusLabel(vectorStore),
      ok: vectorStore?.ok,
    },
    {
      name: "Email delivery",
      detail: runtime?.smtpConfigured
        ? "SMTP configured"
        : "SMTP configuration missing",
      ok: runtime?.smtpConfigured,
    },
  ];
  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <BrandLogo
            className="h-11 w-11 shrink-0 rounded-md border border-[#dce5e9]"
            priority
          />
          <div>
            <strong>REC Assistant</strong>
            <span>NREP Administration</span>
          </div>
        </div>
        <p className="admin-nav-label">Workspace</p>
        <nav aria-label="Administration">
          {navigation.map(([id, label, NavIcon]) => (
            <a
              key={id}
              href={"#" + id}
              aria-current={view === id ? "page" : undefined}
              onClick={() => setView(id)}
            >
              <NavIcon size={18} />
              {label}
              {id === "integrations" && (
                <span className="admin-nav-count">
                  {integrationItems.length}
                </span>
              )}
            </a>
          ))}
        </nav>
        <div className="admin-sidebar-bottom">
          <Link href="/" className="admin-external">
            <ExternalLink size={16} />
            Open public assistant
          </Link>
          <div className="admin-profile">
            <div className="admin-avatar">
              <UserRound size={18} />
            </div>
            <div>
              <strong>{user?.username || "Administrator"}</strong>
              <span>{user?.email}</span>
            </div>
            <button
              className="admin-icon"
              onClick={onLogout}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="admin-workspace">
        <header className="admin-topbar">
          <span>
            Workspace <ChevronRight size={14} />{" "}
            <strong>{navigation.find(([id]) => id === view)?.[1]}</strong>
          </span>
          <span className="admin-badge muted">
            <ShieldCheck size={13} />
            {user?.role === "owner" ? "Owner" : user?.role === "admin" ? "Administrator" : "Viewer"}
          </span>
        </header>
        <div className="admin-content">
          <header className="admin-page-heading">
            <div>
              <p>Renewable Energy Conference & Expo</p>
              <h1>{navigation.find(([id]) => id === view)?.[1]}</h1>
            </div>
            <button
              className="admin-button"
              disabled={Boolean(busyAction)}
              onClick={checkServices}
            >
              <RefreshCw
                size={16}
                className={busyAction === "status" ? "animate-spin" : ""}
              />
              Refresh status
            </button>
          </header>
          {notice && (
            <p role="status" className="admin-notice">
              {notice}
            </p>
          )}
          {view === "overview" && (
            <div className="admin-view">
              {registryError && (
                <p role="alert" className="admin-notice error">
                  {registryError}
                </p>
              )}
              <div className="admin-metrics">
                {[
                  [
                    "API requests today",
                    registry ? totals.requests.toLocaleString() : "-",
                    "UTC daily usage",
                    Activity,
                  ],
                  [
                    "Active integrations",
                    registry ? active : "-",
                    "Shared REC knowledge",
                    KeyRound,
                  ],
                  [
                    "API failures today",
                    registry ? totals.failed : "-",
                    totals.degraded + " degraded responses",
                    ShieldCheck,
                  ],
                  [
                    "Mean response time",
                    totals.finished
                      ? (totals.duration / totals.finished / 1000).toFixed(1) +
                        "s"
                      : "-",
                    "Completed, failed and cancelled",
                    Clock3,
                  ],
                ].map(([label, value, detail, MetricIcon]) => (
                  <article key={label} className="admin-metric">
                    <div>
                      <span>{label}</span>
                      <MetricIcon size={18} />
                    </div>
                    <strong>{value}</strong>
                    <p>{detail}</p>
                  </article>
                ))}
              </div>
              <div className="admin-overview-grid">
                <section className="admin-band">
                  <div className="admin-section-heading">
                    <h2>Service status</h2>
                    <a href="#runtime">
                      View runtime <ArrowUpRight size={15} />
                    </a>
                  </div>
                  {services.map((service) => (
                    <div key={service.name} className="admin-service-row">
                      <span
                        className={
                          "admin-service-dot " + (service.ok ? "ok" : "")
                        }
                      />
                      <div>
                        <strong>{service.name}</strong>
                        <p>{service.detail}</p>
                      </div>
                      <span
                        className={
                          "admin-badge " + (service.ok ? "positive" : "warning")
                        }
                      >
                        {service.ok ? "Ready" : "Check required"}
                      </span>
                    </div>
                  ))}
                  <p className="admin-footnote">
                    Last checked{" "}
                    {status?.receivedAt
                      ? new Date(status.receivedAt).toLocaleTimeString()
                      : "-"}
                    . SMTP status reflects configuration, not a delivery test.
                  </p>
                </section>
                <section className="admin-band">
                  <div className="admin-section-heading">
                    <h2>Conference knowledge</h2>
                    <span className="admin-badge muted">
                      {snapshot?.conference?.shortName || "REC"}
                    </span>
                  </div>
                  <div className="admin-stat-grid">
                    {[
                      ["Sessions", snapshot?.counts?.sessions],
                      ["Programme days", snapshot?.counts?.programs],
                      ["Sponsors", snapshot?.counts?.sponsors],
                      [
                        "Previous editions",
                        snapshot?.counts?.previousConferences,
                      ],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <strong>{value ?? "-"}</strong>
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                  <div className="admin-definition">
                    <span>Snapshot age</span>
                    <strong>
                      {getGeneratedAge(
                        snapshot?.generatedAt,
                        status?.receivedAt,
                      )}
                    </strong>
                  </div>
                  <div className="admin-definition">
                    <span>Public visitor entries</span>
                    <strong>{snapshot?.counts?.operationalInfo ?? "-"}</strong>
                  </div>
                </section>
              </div>
              <section className="admin-band">
                <div className="admin-section-heading">
                  <h2>Integration activity</h2>
                  <a href="#integrations">
                    Manage integrations <ArrowUpRight size={15} />
                  </a>
                </div>
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Action</th>
                        <th>Integration</th>
                        <th>Administrator</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(registry?.audit || []).slice(0, 8).map((entry) => (
                        <tr key={entry.id}>
                          <td>
                            <span className="admin-badge muted">
                              {entry.action.replaceAll("_", " ")}
                            </span>
                          </td>
                          <td>
                            {integrationItems.find(
                              (item) => item.id === entry.integration_id,
                            )?.name || entry.integration_id}
                          </td>
                          <td>{entry.actor}</td>
                          <td>{new Date(entry.at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!registry?.audit?.length && (
                  <div className="admin-empty small">
                    <Activity size={24} />
                    <p>No integration activity recorded.</p>
                  </div>
                )}
              </section>
            </div>
          )}
          {canManage && (
            <div hidden={view !== "knowledge"}>
              <KnowledgeEditor onStatusRefresh={refreshStatus} />
            </div>
          )}
          {view === "runtime" && (
            <div className="admin-view">
              <section className="admin-band">
                <div className="admin-section-heading">
                  <h2>Conference data</h2>
                  <span
                    className={
                      "admin-badge " + (snapshot?.ok ? "positive" : "warning")
                    }
                  >
                    {snapshot?.ok ? "Snapshot ready" : "Snapshot missing"}
                  </span>
                </div>
                <div className="admin-definition">
                  <span>Active conference</span>
                  <strong>{snapshot?.conference?.title || "-"}</strong>
                </div>
                <div className="admin-definition">
                  <span>Generated</span>
                  <strong>
                    {snapshot?.generatedAt
                      ? new Date(snapshot.generatedAt).toLocaleString()
                      : "-"}
                  </strong>
                </div>
                <div className="admin-stat-grid">
                  {[
                    ["Sessions", "sessions"],
                    ["Time blocks", "timeBlocks"],
                    ["Sponsor categories", "sponsorCategories"],
                    ["Historical media", "historicalMediaItems"],
                  ].map(([label, key]) => (
                    <div key={key}>
                      <strong>{snapshot?.counts?.[key] ?? "-"}</strong>
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
                {canManage && <div className="admin-toolbar">
                  <button
                    className="admin-button primary"
                    disabled={Boolean(busyAction)}
                    onClick={() => setConfirmRefresh(false)}
                  >
                    <RefreshCw size={16} />
                    Refresh snapshot
                  </button>
                  <button
                    className="admin-button"
                    disabled={Boolean(busyAction)}
                    onClick={() => setConfirmRefresh(true)}
                  >
                    <Database size={16} />
                    Refresh & rebuild index
                  </button>
                </div>}
              </section>
              <div className="admin-overview-grid">
                <section className="admin-band">
                  <div className="admin-section-heading">
                    <h2>Model configuration</h2>
                    <span className="admin-badge muted">Server managed</span>
                  </div>
                  {[
                    ["Answer model", runtime?.chatModel],
                    ["Planner model", runtime?.plannerModel],
                    ["Embedding model", runtime?.embedModel],
                    [
                      "Planner",
                      runtime?.plannerEnabled ? "Enabled" : "Disabled",
                    ],
                    [
                      "Full REC context",
                      runtime?.recFullContextEnabled
                        ? runtime.recFullContextMode
                        : "Disabled",
                    ],
                  ].map(([label, value]) => (
                    <div className="admin-definition" key={label}>
                      <span>{label}</span>
                      <strong>{value || "-"}</strong>
                    </div>
                  ))}
                </section>
                <section className="admin-band">
                  <div className="admin-section-heading">
                    <h2>Vector index</h2>
                    <Network size={20} />
                  </div>
                  {!vectorStore?.ok && (
                    <p className="admin-notice warning">
                      {vectorStore?.message || "Vector index unavailable."}{" "}
                      {vectorStore?.nextAction}
                    </p>
                  )}
                  {[
                    ["Collection", vectorStore?.collection],
                    ["Points", vectorStore?.pointsCount],
                    [
                      "Qdrant complement",
                      runtime?.qdrantComplementEnabled
                        ? runtime.qdrantComplementMode
                        : "Disabled",
                    ],
                    [
                      "Full indexed context",
                      runtime?.qdrantFullContextEnabled
                        ? runtime.qdrantFullContextMode
                        : "Disabled",
                    ],
                  ].map(([label, value]) => (
                    <div key={label} className="admin-definition">
                      <span>{label}</span>
                      <strong>{value ?? "-"}</strong>
                    </div>
                  ))}
                </section>
              </div>
            </div>
          )}
          {view === "integrations" && (
            <Integrations
              registry={registry}
              reload={loadRegistry}
              loading={registryLoading}
              loadError={registryError}
              canManage={canManage}
            />
          )}
          {view === "access" && (
            <Access user={user} onStatusRefresh={refreshStatus} />
          )}
        </div>
        <footer className="admin-footer">
          <span>NREP · REC Assistant</span>
          <span>Public conference knowledge</span>
        </footer>
      </div>
      {confirmRefresh !== null && (
        <AdminDialog
          title={
            confirmRefresh
              ? "Rebuild conference index?"
              : "Refresh conference snapshot?"
          }
          busy={Boolean(busyAction)}
          onClose={() => setConfirmRefresh(null)}
        >
          <div className="admin-dialog-body">
            <p>
              {confirmRefresh
                ? "This pulls public conference data from Appwrite and rebuilds Qdrant. Retrieval may be temporarily unavailable during rebuilding."
                : "This replaces the generated snapshot with the latest public conference data from Appwrite."}
            </p>
          </div>
          <footer className="admin-dialog-footer">
            <button
              className="admin-button"
              disabled={Boolean(busyAction)}
              onClick={() => setConfirmRefresh(null)}
            >
              Cancel
            </button>
            <button
              className="admin-button primary"
              disabled={Boolean(busyAction)}
              onClick={() => refreshBot(confirmRefresh)}
            >
              <RefreshCw size={16} />
              {busyAction ? "Refreshing..." : "Confirm refresh"}
            </button>
          </footer>
        </AdminDialog>
      )}
    </main>
  );
}

export default function AdminPage() {
  const [authState, setAuthState] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");

  async function loadAuth() {
    setPageError("");
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
    setPageError("");
  }

  async function logout() {
    try {
      await postJson("/api/admin/auth/logout");
      setStatus(null);
      setAuthState(null);
      await loadAuth();
    } catch (error) {
      setPageError(error.message);
    }
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
      } catch (error) {
        if (!cancelled)
          setPageError(error.message || "Administration is unavailable.");
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
      <main className="admin-auth">
        <div className="admin-auth-main">
          <div className="flex items-center gap-4" role="status">
            <BrandLogo
              className="h-10 w-10 rounded-md border border-white/20"
              priority
            />
            <div>
              <span className="block text-sm font-medium">
                Loading administration
              </span>
              <span className="mt-1 block text-xs text-[#B9DCE9]">
                Checking your secure session
              </span>
            </div>
            <Icon
              name="activity"
              className="ml-2 h-5 w-5 animate-pulse text-[#176F91]"
            />
          </div>
        </div>
      </main>
    );
  }

  if (!authState?.authenticated) {
    return (
      <>
        {pageError && (
          <p className="admin-notice error" role="alert">
            {pageError}
          </p>
        )}
        <AuthPanel
          onAuthenticated={() =>
            loadAuth().catch((error) => {
              setPageError(error.message);
              setLoading(false);
            })
          }
        />
      </>
    );
  }

  return (
    <>
      {pageError && (
        <p className="admin-notice error" role="alert">
          {pageError}
        </p>
      )}
      <Dashboard
        user={authState.user}
        status={status}
        refreshStatus={loadStatus}
        onLogout={logout}
      />
    </>
  );
}
