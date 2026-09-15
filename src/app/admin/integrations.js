"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldOff,
  X,
} from "lucide-react";

export async function integrationRequest(body) {
  const response = await fetch(
    "/api/admin/integrations",
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message || data.error || "Unable to load integrations.",
    );
  return data;
}

export function AdminDialog({ title, children, onClose, busy = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="admin-dialog"
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="admin-dialog-header">
        <h2 id="dialog-title">{title}</h2>
        <button
          type="button"
          className="admin-icon"
          aria-label="Close dialog"
          title="Close"
          disabled={busy}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function IntegrationStatus({ item, now }) {
  const state = item.revokedAt
    ? "Revoked"
    : !item.enabled
      ? "Disabled"
      : Date.parse(item.expiresAt) <= now
        ? "Expired"
        : "Active";
  return (
    <span
      className={
        "admin-badge " +
        (state === "Active"
          ? "positive"
          : state === "Revoked"
            ? "muted"
            : "warning")
      }
    >
      {state}
    </span>
  );
}

function SettingsForm({ item, onSave, onClose, busy, error }) {
  const [values, setValues] = useState(() => ({
    name: item?.name || "",
    description: item?.description || "",
    enabled: item?.enabled ?? true,
    requestsPerMinute: item?.requestsPerMinute || 20,
    requestsPerDay: item?.requestsPerDay || 1000,
    maxConcurrent: item?.maxConcurrent || 1,
    expiresAt: (
      item?.expiresAt || new Date(Date.now() + 90 * 86400000).toISOString()
    ).slice(0, 10),
  }));
  const update = (field, value) =>
    setValues((current) => ({ ...current, [field]: value }));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          ...values,
          expiresAt: new Date(values.expiresAt + "T23:59:59Z").toISOString(),
        });
      }}
    >
      <div className="admin-dialog-body admin-form">
        {error && (
          <p role="alert" className="admin-notice error">
            {error}
          </p>
        )}
        <label>
          Integration name
          <input
            autoFocus
            required
            minLength={2}
            maxLength={80}
            value={values.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="REC website backend"
          />
        </label>
        <label>
          Description <span className="admin-muted">(optional)</span>
          <textarea
            maxLength={300}
            rows={2}
            value={values.description}
            onChange={(e) => update("description", e.target.value)}
          />
        </label>
        <div className="admin-form-row">
          <label>
            Requests / minute
            <input
              type="number"
              required
              min={1}
              max={600}
              value={values.requestsPerMinute}
              onChange={(e) =>
                update("requestsPerMinute", Number(e.target.value))
              }
            />
          </label>
          <label>
            Requests / day
            <input
              type="number"
              required
              min={1}
              max={100000}
              value={values.requestsPerDay}
              onChange={(e) => update("requestsPerDay", Number(e.target.value))}
            />
          </label>
        </div>
        <div className="admin-form-row">
          <label>
            Concurrent requests
            <input
              type="number"
              required
              min={1}
              max={10}
              value={values.maxConcurrent}
              onChange={(e) => update("maxConcurrent", Number(e.target.value))}
            />
          </label>
          <label>
            Key expires (UTC)
            <input
              type="date"
              required
              value={values.expiresAt}
              onChange={(e) => update("expiresAt", e.target.value)}
            />
          </label>
        </div>
        <div className="admin-definition">
          <span>Knowledge scope</span>
          <strong>Shared public REC knowledge</strong>
        </div>
        <label className="admin-check">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(e) => update("enabled", e.target.checked)}
          />{" "}
          Integration enabled
        </label>
      </div>
      <footer className="admin-dialog-footer">
        <button
          type="button"
          className="admin-button"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
        <button className="admin-button primary" disabled={busy}>
          <Check size={16} />
          {busy ? "Saving..." : item ? "Save changes" : "Create integration"}
        </button>
      </footer>
    </form>
  );
}

export default function Integrations({ registry, reload, loading, loadError }) {
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [page, setPage] = useState(0);
  const [modal, setModal] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [secret, setSecret] = useState(null),
    [copied, setCopied] = useState(false),
    [notice, setNotice] = useState("");
  const items = registry?.integrations || [];
  const now = registry?.receivedAt || 0;
  const filtered = items.filter(
    (item) =>
      (item.name + " " + item.description)
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "active"
          ? !item.revokedAt && item.enabled && Date.parse(item.expiresAt) > now
          : item.revokedAt ||
            !item.enabled ||
            Date.parse(item.expiresAt) <= now)),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 8)),
    currentPage = Math.min(page, pages - 1);
  const open = (action, item) => {
    setError("");
    setModal({ action, item });
  };
  async function mutate(settings) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await integrationRequest({
        action: modal.action,
        ...(modal.item
          ? { id: modal.item.id, version: modal.item.version }
          : {}),
        ...(settings ? { settings } : {}),
      });
      const action = modal.action;
      setModal(null);
      if (result.key) {
        setCopied(false);
        setSecret({ key: result.key, name: result.integration.name });
      } else
        setNotice(
          action === "revoke" ? "Integration revoked." : "Integration updated.",
        );
      await reload();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setError(
        "Clipboard access is unavailable. The key remains visible below.",
      );
    }
  }
  return (
    <div className="admin-view">
      <div className="admin-section-heading">
        <div>
          <h2>
            API integrations <span className="admin-count">{items.length}</span>
          </h2>
          <p>Shared REC knowledge · Server-to-server access</p>
        </div>
        <button className="admin-button primary" onClick={() => open("create")}>
          <Plus size={17} />
          New integration
        </button>
      </div>
      {notice && (
        <p className="admin-notice" role="status">
          {notice}
        </p>
      )}
      {loadError && (
        <p className="admin-notice error" role="alert">
          {loadError}
        </p>
      )}
      <div className="admin-toolbar">
        <label className="admin-search">
          <Search size={17} />
          <input
            aria-label="Search integrations"
            placeholder="Search integrations"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <select
          aria-label="Integration status filter"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(0);
          }}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <button
          className="admin-icon"
          title="Refresh integrations"
          aria-label="Refresh integrations"
          disabled={loading}
          onClick={reload}
        >
          <RefreshCw size={17} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Integration</th>
              <th>Status</th>
              <th>Today / quota</th>
              <th>Limits</th>
              <th>Key expiry</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered
              .slice(currentPage * 8, currentPage * 8 + 8)
              .map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                    <span className="admin-cell-detail">
                      {item.description || item.keyPrefix}
                    </span>
                  </td>
                  <td>
                    <IntegrationStatus item={item} now={now} />
                  </td>
                  <td>
                    <strong>
                      {item.usage.admitted.toLocaleString()}{" "}
                      <span className="admin-muted">
                        / {item.requestsPerDay.toLocaleString()}
                      </span>
                    </strong>
                    <span className="admin-cell-detail">
                      {item.usage.failed} failed · {item.usage.degraded}{" "}
                      degraded
                    </span>
                  </td>
                  <td>
                    {item.requestsPerMinute}/min
                    <span className="admin-cell-detail">
                      {item.activeRequests}/{item.maxConcurrent} running
                    </span>
                  </td>
                  <td>
                    {new Date(item.expiresAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      timeZone: "UTC",
                    })}
                  </td>
                  <td>
                    <div className="admin-actions">
                      <button
                        disabled={Boolean(item.revokedAt)}
                        className="admin-icon"
                        title={"Edit " + item.name}
                        aria-label={"Edit " + item.name}
                        onClick={() => open("update", item)}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        disabled={Boolean(item.revokedAt)}
                        className="admin-icon"
                        title={"Rotate key for " + item.name}
                        aria-label={"Rotate key for " + item.name}
                        onClick={() => open("rotate", item)}
                      >
                        <KeyRound size={16} />
                      </button>
                      <button
                        disabled={Boolean(item.revokedAt)}
                        className="admin-icon danger"
                        title={"Revoke " + item.name}
                        aria-label={"Revoke " + item.name}
                        onClick={() => open("revoke", item)}
                      >
                        <ShieldOff size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!filtered.length && (
        <div className="admin-empty">
          <KeyRound size={28} />
          <h3>
            {loading
              ? "Loading integrations"
              : query || filter !== "all"
                ? "No matching integrations"
                : "No integrations yet"}
          </h3>
          {!loading && !query && filter === "all" && (
            <button className="admin-button" onClick={() => open("create")}>
              <Plus size={16} />
              Register an application
            </button>
          )}
        </div>
      )}
      <div className="admin-pagination">
        <span>
          {filtered.length} integration{filtered.length === 1 ? "" : "s"} ·
          Usage day {registry?.usageDay || "-"} UTC
        </span>
        <div className="admin-actions">
          <button
            className="admin-icon"
            title="Previous page"
            aria-label="Previous page"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={17} />
          </button>
          <span>
            {currentPage + 1} / {pages}
          </span>
          <button
            className="admin-icon"
            title="Next page"
            aria-label="Next page"
            disabled={currentPage + 1 >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
      <section className="admin-band">
        <div className="admin-section-heading">
          <h2>Developer resources</h2>
          <a className="admin-button" href="/rec-chat.openapi.json" download>
            <Download size={16} />
            OpenAPI specification
          </a>
        </div>
        <div className="admin-definition">
          <span>Chat endpoint</span>
          <code>POST /api/v1/chat</code>
        </div>
        <div className="admin-definition">
          <span>Authentication</span>
          <code>Authorization: Bearer &lt;API_KEY&gt;</code>
        </div>
        <div className="admin-definition">
          <span>Response formats</span>
          <strong>JSON · Server-sent events</strong>
        </div>
        <p className="admin-notice warning">
          Keep API keys on your backend. Never embed them in a website, mobile
          app, or public repository.
        </p>
      </section>
      {modal && (
        <AdminDialog
          title={
            modal.action === "create"
              ? "New integration"
              : modal.action === "update"
                ? "Edit integration"
                : modal.action === "rotate"
                  ? "Rotate API key"
                  : "Revoke integration"
          }
          onClose={() => setModal(null)}
          busy={busy}
        >
          {["create", "update"].includes(modal.action) ? (
            <SettingsForm
              item={modal.item}
              onSave={mutate}
              onClose={() => setModal(null)}
              busy={busy}
              error={error}
            />
          ) : (
            <>
              <div className="admin-dialog-body">
                {error && (
                  <p role="alert" className="admin-notice error">
                    {error}
                  </p>
                )}
                <p>
                  <strong>{modal.item.name}</strong>
                </p>
                <p className="admin-muted">
                  {modal.action === "rotate"
                    ? "The existing key will stop accepting new requests immediately. The replacement key expires in 90 days."
                    : "This permanently blocks new requests. Requests already running may finish. A revoked integration cannot be re-enabled."}
                </p>
              </div>
              <footer className="admin-dialog-footer">
                <button
                  className="admin-button"
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
                <button
                  className={
                    "admin-button " +
                    (modal.action === "revoke" ? "destructive" : "primary")
                  }
                  disabled={busy}
                  onClick={() => mutate()}
                >
                  {busy
                    ? "Working..."
                    : modal.action === "rotate"
                      ? "Rotate key"
                      : "Revoke integration"}
                </button>
              </footer>
            </>
          )}
        </AdminDialog>
      )}
      {secret && (
        <AdminDialog title="API key created" onClose={() => setSecret(null)}>
          <div className="admin-dialog-body admin-form">
            <p>
              <strong>{secret.name}</strong>
            </p>
            <p className="admin-notice warning">
              This key is shown once. Store it in your backend secret manager
              before closing.
            </p>
            {error && (
              <p role="alert" className="admin-notice error">
                {error}
              </p>
            )}
            <label>
              Secret API key
              <textarea
                readOnly
                spellCheck={false}
                rows={3}
                value={secret.key}
              />
            </label>
            <button className="admin-button" onClick={() => copy(secret.key)}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? "Copied" : "Copy key"}
            </button>
          </div>
          <footer className="admin-dialog-footer">
            <button
              className="admin-button primary"
              onClick={() => setSecret(null)}
            >
              Done
            </button>
          </footer>
        </AdminDialog>
      )}
    </div>
  );
}
