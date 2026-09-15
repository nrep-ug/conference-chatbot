"use client";

import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { AdminDialog } from "./integrations";

const roleLabel = { owner: "Owner", admin: "Administrator", viewer: "Viewer" };

async function accountRequest(body) {
  const response = await fetch(
    "/api/admin/users",
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error?.message || data.error || "Unable to load accounts.");
  return data;
}

export default function Access({ user, onStatusRefresh }) {
  const owner = user?.role === "owner";
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(owner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("admin");

  async function reload() {
    if (!owner) return;
    setLoading(true);
    setError("");
    try {
      const data = await accountRequest();
      setAccounts(data.users || []);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    accountRequest()
      .then((data) => {
        if (!cancelled) setAccounts(data.users || []);
      })
      .catch((failure) => {
        if (!cancelled) setError(failure.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [owner]);

  function open(action, item = null) {
    setDialog({ action, item });
    setEmail(item?.email || "");
    setRole(item?.role || "admin");
    setError("");
    setNotice("");
  }

  async function save(event) {
    event.preventDefault();
    if (!dialog || busy) return;
    setBusy(true);
    setError("");
    try {
      const action = dialog.action;
      await accountRequest({
        action,
        email: action === "invite" ? email.trim() : dialog.item.email,
        ...(action !== "revoke" ? { role } : {}),
        ...(dialog.item ? { version: dialog.item.version } : {}),
      });
      setDialog(null);
      setNotice(
        action === "invite"
          ? "Email approved. The account is pending verification and setup."
          : action === "role"
            ? "Role updated. Existing sessions for that account were ended."
            : "Account access revoked.",
      );
      await reload();
      await onStatusRefresh();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const filtered = accounts.filter((item) =>
    `${item.email} ${item.username} ${item.role}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const currentPage = Math.min(page, pages - 1);

  return (
    <div className="admin-view">
      <div className="admin-section-heading">
        <div>
          <h2>
            Approved accounts {owner && <span className="admin-count">{accounts.length}</span>}
          </h2>
          <p>Password and email-code verification</p>
        </div>
        {owner && (
          <button className="admin-button primary" onClick={() => open("invite")}>
            <Plus size={17} />
            Add account
          </button>
        )}
      </div>
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      {error && !dialog && <p className="admin-notice error" role="alert">{error}</p>}
      {owner && (
        <>
          <div className="admin-toolbar">
            <label className="admin-search">
              <Search size={17} />
              <input
                aria-label="Search accounts"
                placeholder="Search accounts"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            <button
              className="admin-icon"
              title="Refresh accounts"
              aria-label="Refresh accounts"
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
                  <th>Account</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filtered.slice(currentPage * 8, currentPage * 8 + 8).map((item) => (
                  <tr key={item.email}>
                    <td>
                      <strong>{item.username || "Pending setup"}</strong>
                      {item.lastLoginAt && (
                        <span className="admin-cell-detail">
                          Last sign-in {new Date(item.lastLoginAt).toLocaleDateString("en-GB")}
                        </span>
                      )}
                    </td>
                    <td>{item.email}</td>
                    <td>{roleLabel[item.role] || item.role}</td>
                    <td>
                      <span className={`admin-badge ${item.configured ? "positive" : "warning"}`}>
                        {item.configured ? "Configured" : "Pending"}
                      </span>
                    </td>
                    <td>
                      <div className="admin-actions">
                        <button
                          className="admin-icon"
                          disabled={item.email === user.email}
                          title={`Change role for ${item.email}`}
                          aria-label={`Change role for ${item.email}`}
                          onClick={() => open("role", item)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="admin-icon danger"
                          disabled={item.email === user.email}
                          title={`Revoke ${item.email}`}
                          aria-label={`Revoke ${item.email}`}
                          onClick={() => open("revoke", item)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && !filtered.length && (
            <div className="admin-empty small">
              <UserRound size={24} />
              <span>{query ? "No matching accounts" : "No approved accounts"}</span>
            </div>
          )}
          <div className="admin-pagination">
            <span>{filtered.length} account{filtered.length === 1 ? "" : "s"}</span>
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
              <span>{currentPage + 1} / {pages}</span>
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
        </>
      )}
      <section className="admin-band">
        <div className="admin-section-heading">
          <h2>Session security</h2>
          <span className="admin-badge muted"><ShieldCheck size={14} /> {roleLabel[user?.role] || "Account"}</span>
        </div>
        <div className="admin-definition">
          <span>Signed in as</span>
          <strong>{user?.email}</strong>
        </div>
        <div className="admin-definition">
          <span>Authentication</span>
          <strong>Password and email verification code</strong>
        </div>
      </section>
      {dialog && (
        <AdminDialog
          title={dialog.action === "invite" ? "Add account" : dialog.action === "role" ? "Change account role" : "Revoke account"}
          busy={busy}
          onClose={() => setDialog(null)}
        >
          <form onSubmit={save}>
            <div className="admin-dialog-body admin-form">
              {error && <p className="admin-notice error" role="alert">{error}</p>}
              {dialog.action === "revoke" ? (
                <p>Revoke access for <strong>{dialog.item.email}</strong>? Active sessions and unused verification codes will be invalidated.</p>
              ) : (
                <>
                  <label>
                    Email address
                    <input
                      type="email"
                      value={email}
                      readOnly={dialog.action !== "invite"}
                      required
                      maxLength={254}
                      autoFocus={dialog.action === "invite"}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                  <label>
                    Role
                    <select value={role} onChange={(event) => setRole(event.target.value)}>
                      <option value="admin">Administrator</option>
                      <option value="viewer">Viewer</option>
                      <option value="owner">Owner</option>
                    </select>
                  </label>
                </>
              )}
            </div>
            <footer className="admin-dialog-footer">
              <button type="button" className="admin-button" disabled={busy} onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" className={`admin-button ${dialog.action === "revoke" ? "destructive" : "primary"}`} disabled={busy}>
                {busy ? "Working..." : dialog.action === "invite" ? "Approve email" : dialog.action === "role" ? "Save role" : "Revoke access"}
              </button>
            </footer>
          </form>
        </AdminDialog>
      )}
    </div>
  );
}
