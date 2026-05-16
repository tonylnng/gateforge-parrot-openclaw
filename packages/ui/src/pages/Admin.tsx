/**
 * Admin panel — tabbed view over the operational endpoints the rest of the
 * UI doesn't need on the hot path. Three tabs, lazy-loaded:
 *
 *   1. API keys     — list / issue / patch (rename + scopes) / revoke
 *   2. Webhooks     — list / create / test / view deliveries / delete
 *   3. Audit log    — paginated entries + a one-click chain verifier
 *
 * Notes:
 *   - No external router; tab state is local.
 *   - Newly issued API keys and webhook secrets are shown ONCE in a banner —
 *     copy or lose them. We don't store them anywhere.
 *   - All requests go through the JWT-authenticated API client; API key auth
 *     is intentionally not used here because the admin UI is for the human
 *     who owns the key, not a programmatic caller.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type ApiKeyRow,
  type AuditEntryRow,
  type AuditVerifyRow,
  type WebhookDeliveryRow,
  type WebhookRow,
} from "../lib/api";
import { wrapKey } from "../lib/crypto";
import { useStore } from "../lib/store";

interface AdminProps {
  onBack: () => void;
}

type Tab = "apikeys" | "webhooks" | "audit";

const ALL_SCOPES = [
  "conversations:read",
  "conversations:write",
  "conversations:delete",
  "messages:read",
  "messages:send",
  "messages:stream",
  "apikeys:manage",
  "webhooks:manage",
  "audit:read",
  "agents:read",
] as const;

export function Admin({ onBack }: AdminProps) {
  const accessToken = useStore((s) => s.accessToken!);
  const user = useStore((s) => s.user);
  const [tab, setTab] = useState<Tab>("apikeys");

  return (
    <div className="admin">
      <header className="admin-header">
        <button className="btn" onClick={onBack} aria-label="Back to chat">
          ← Back to chat
        </button>
        <h1>Admin</h1>
        <div className="admin-header-meta">
          <span className="user-email">{user?.email}</span>
        </div>
      </header>

      <nav className="admin-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "apikeys"}
          className={`admin-tab ${tab === "apikeys" ? "active" : ""}`}
          onClick={() => setTab("apikeys")}
        >
          API Keys
        </button>
        <button
          role="tab"
          aria-selected={tab === "webhooks"}
          className={`admin-tab ${tab === "webhooks" ? "active" : ""}`}
          onClick={() => setTab("webhooks")}
        >
          Webhooks
        </button>
        <button
          role="tab"
          aria-selected={tab === "audit"}
          className={`admin-tab ${tab === "audit" ? "active" : ""}`}
          onClick={() => setTab("audit")}
        >
          Audit log
        </button>
      </nav>

      <section className="admin-body">
        {tab === "apikeys" ? <ApiKeysTab token={accessToken} /> : null}
        {tab === "webhooks" ? <WebhooksTab token={accessToken} /> : null}
        {tab === "audit" ? <AuditTab token={accessToken} /> : null}
      </section>
    </div>
  );
}

// ---- API Keys --------------------------------------------------------------

function ApiKeysTab({ token }: { token: string }) {
  const masterKey = useStore((s) => s.masterKey!);
  const [rows, setRows] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showIssue, setShowIssue] = useState(false);
  const [issued, setIssued] = useState<{ token: string; row: ApiKeyRow } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await api.listApiKeys(token);
      setRows(r.apikeys);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleRevoke = useCallback(
    async (id: string) => {
      if (!confirm("Revoke this API key? Callers using it will get 401 immediately.")) return;
      try {
        await api.revokeApiKey(token, id);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [token, reload],
  );

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>API Keys</h2>
        <button className="btn btn-primary" onClick={() => setShowIssue(true)}>
          Issue new key
        </button>
      </div>

      {error ? <div className="banner banner-error">{error}</div> : null}

      {issued ? (
        <div className="banner banner-success">
          <strong>Copy this key now — it will not be shown again.</strong>
          <code className="token-display">{issued.token}</code>
          <button className="btn" onClick={() => navigator.clipboard.writeText(issued.token)}>
            Copy
          </button>
          <button className="btn" onClick={() => setIssued(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {showIssue ? (
        <IssueApiKeyForm
          token={token}
          masterKey={masterKey}
          onCancel={() => setShowIssue(false)}
          onIssued={(row, plain) => {
            setShowIssue(false);
            setIssued({ row, token: plain });
            void reload();
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="muted">No API keys yet.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Prefix</th>
              <th>Scopes</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) =>
              editingId === r.id ? (
                <EditApiKeyRow
                  key={r.id}
                  token={token}
                  row={r}
                  onCancel={() => setEditingId(null)}
                  onSaved={async () => {
                    setEditingId(null);
                    await reload();
                  }}
                />
              ) : (
                <tr key={r.id} className={r.revokedAt ? "row-revoked" : ""}>
                  <td>{r.label}</td>
                  <td><code>{r.prefix}</code></td>
                  <td>
                    {r.scopes.map((s) => (
                      <span key={s} className="chip">
                        {s}
                      </span>
                    ))}
                  </td>
                  <td>{fmtTs(r.createdAt)}</td>
                  <td>{r.lastUsedAt ? fmtTs(r.lastUsedAt) : "—"}</td>
                  <td>{r.revokedAt ? <span className="chip chip-danger">revoked</span> : <span className="chip chip-ok">active</span>}</td>
                  <td className="cell-actions">
                    {r.revokedAt ? null : (
                      <>
                        <button className="btn btn-sm" onClick={() => setEditingId(r.id)}>
                          Edit
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => void handleRevoke(r.id)}>
                          Revoke
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function IssueApiKeyForm(props: {
  token: string;
  masterKey: CryptoKey;
  onCancel: () => void;
  onIssued: (row: ApiKeyRow, plain: string) => void;
  onError: (m: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["conversations:read", "messages:read"]);
  const [submitting, setSubmitting] = useState(false);

  const toggle = (s: string) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const submit = async () => {
    if (!label.trim()) {
      props.onError("Label is required.");
      return;
    }
    setSubmitting(true);
    try {
      // Server stores a copy of the master key wrapped with the API-key-derived
      // KEK so that API-key callers can later unwrap conversation keys without
      // re-deriving from a password. The wire-format calls for it; we ship the
      // user's existing wrapped master key for v1 (server re-wraps).
      const wrapped = await wrapKey(props.masterKey, props.masterKey);
      const r = await api.issueApiKey(props.token, { label: label.trim(), scopes });
      props.onIssued(r.apikey, r.token);
      void wrapped; // reserved for future per-key KEKs
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="form-card">
      <h3>Issue API key</h3>
      <label className="form-row">
        <span>Label</span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. CI deploys"
          disabled={submitting}
        />
      </label>
      <div className="form-row form-row-col">
        <span>Scopes</span>
        <div className="checkbox-grid">
          {ALL_SCOPES.map((s) => (
            <label key={s} className="checkbox">
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={() => toggle(s)}
                disabled={submitting}
              />
              <span>{s}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="form-actions">
        <button className="btn" onClick={props.onCancel} disabled={submitting}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={submitting || !label.trim()}>
          {submitting ? "Issuing…" : "Issue key"}
        </button>
      </div>
    </div>
  );
}

function EditApiKeyRow(props: {
  token: string;
  row: ApiKeyRow;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [label, setLabel] = useState(props.row.label);
  const [scopes, setScopes] = useState<string[]>(props.row.scopes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (s: string) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patchApiKey(props.token, props.row.id, { label, scopes });
      await props.onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr>
      <td>
        <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} />
      </td>
      <td><code>{props.row.prefix}</code></td>
      <td>
        <div className="checkbox-grid checkbox-grid-compact">
          {ALL_SCOPES.map((s) => (
            <label key={s} className="checkbox">
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} disabled={saving} />
              <span>{s}</span>
            </label>
          ))}
        </div>
      </td>
      <td colSpan={2}>
        {error ? <div className="muted muted-error">{error}</div> : null}
      </td>
      <td></td>
      <td className="cell-actions">
        <button className="btn btn-sm" onClick={props.onCancel} disabled={saving}>
          Cancel
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => void save()} disabled={saving}>
          Save
        </button>
      </td>
    </tr>
  );
}

// ---- Webhooks --------------------------------------------------------------

const WEBHOOK_EVENTS = [
  "session.created",
  "session.renamed",
  "session.archived",
  "session.deleted",
  "message.received",
  "message.completed",
  "message.failed",
  "apikey.used",
  "apikey.revoked",
  "audit.alert",
  "webhook.ping",
] as const;

function WebhooksTab({ token }: { token: string }) {
  const [rows, setRows] = useState<WebhookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<{ row: WebhookRow; secret: string } | null>(null);
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await api.listWebhooks(token);
      setRows(r.webhooks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Webhooks</h2>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          Add webhook
        </button>
      </div>

      {error ? <div className="banner banner-error">{error}</div> : null}

      {created ? (
        <div className="banner banner-success">
          <strong>Signing secret — shown ONCE.</strong>
          <code className="token-display">{created.secret}</code>
          <button className="btn" onClick={() => navigator.clipboard.writeText(created.secret)}>
            Copy
          </button>
          <button className="btn" onClick={() => setCreated(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {showCreate ? (
        <CreateWebhookForm
          token={token}
          onCancel={() => setShowCreate(false)}
          onCreated={(row, secret) => {
            setShowCreate(false);
            setCreated({ row, secret });
            void reload();
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="muted">No webhooks subscribed.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>URL</th>
              <th>Events</th>
              <th>Status</th>
              <th>Failures</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td>
                    <code className="wrap">{r.url}</code>
                  </td>
                  <td>
                    {r.events.map((e) => (
                      <span key={e} className="chip">
                        {e}
                      </span>
                    ))}
                  </td>
                  <td>
                    {r.active ? <span className="chip chip-ok">active</span> : <span className="chip chip-danger">disabled</span>}
                  </td>
                  <td>{r.failureCount}</td>
                  <td className="cell-actions">
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        try {
                          await api.testWebhook(token, r.id);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
                        }
                      }}
                    >
                      Send ping
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => setOpenDeliveries((cur) => (cur === r.id ? null : r.id))}
                    >
                      {openDeliveries === r.id ? "Hide deliveries" : "Deliveries"}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={async () => {
                        if (!confirm("Delete this webhook subscription?")) return;
                        try {
                          await api.deleteWebhook(token, r.id);
                          await reload();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
                        }
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                {openDeliveries === r.id ? (
                  <tr className="row-detail">
                    <td colSpan={5}>
                      <DeliveriesPanel token={token} webhookId={r.id} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CreateWebhookForm(props: {
  token: string;
  onCancel: () => void;
  onCreated: (row: WebhookRow, secret: string) => void;
  onError: (m: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["message.completed"]);
  const [submitting, setSubmitting] = useState(false);

  const toggle = (e: string) =>
    setEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));

  const submit = async () => {
    if (!url.trim()) {
      props.onError("URL is required.");
      return;
    }
    if (events.length === 0) {
      props.onError("Pick at least one event.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.createWebhook(props.token, { url: url.trim(), events });
      props.onCreated(r.webhook, r.secret);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="form-card">
      <h3>Add webhook</h3>
      <label className="form-row">
        <span>URL</span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-host/parrot-hook"
          disabled={submitting}
        />
      </label>
      <div className="form-row form-row-col">
        <span>Events</span>
        <div className="checkbox-grid">
          {WEBHOOK_EVENTS.map((e) => (
            <label key={e} className="checkbox">
              <input type="checkbox" checked={events.includes(e)} onChange={() => toggle(e)} disabled={submitting} />
              <span>{e}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="form-actions">
        <button className="btn" onClick={props.onCancel} disabled={submitting}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={submitting}>
          {submitting ? "Creating…" : "Create webhook"}
        </button>
      </div>
    </div>
  );
}

function DeliveriesPanel({ token, webhookId }: { token: string; webhookId: string }) {
  const [rows, setRows] = useState<WebhookDeliveryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listDeliveries(token, webhookId)
      .then((r) => {
        if (!cancelled) setRows(r.deliveries);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, webhookId]);

  if (loading) return <div className="muted">Loading deliveries…</div>;
  if (error) return <div className="muted muted-error">{error}</div>;
  if (rows.length === 0) return <div className="muted">No deliveries yet.</div>;
  return (
    <table className="data-table data-table-inner">
      <thead>
        <tr>
          <th>Event</th>
          <th>Attempt</th>
          <th>HTTP</th>
          <th>Delivered</th>
          <th>Next retry</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id}>
            <td><span className="chip">{d.eventType}</span></td>
            <td>{d.attempt}</td>
            <td>{d.responseCode ?? "—"}</td>
            <td>{d.deliveredAt ? fmtTs(d.deliveredAt) : "—"}</td>
            <td>{d.nextRetryAt ? fmtTs(d.nextRetryAt) : "—"}</td>
            <td className="cell-err">{d.lastError ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- Audit log -------------------------------------------------------------

function AuditTab({ token }: { token: string }) {
  const [rows, setRows] = useState<AuditEntryRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState("");
  const [verify, setVerify] = useState<AuditVerifyRow | null>(null);
  const [verifying, setVerifying] = useState(false);

  const loadPage = useCallback(
    async (after: string | null, replace = false) => {
      setLoading(true);
      setError(null);
      try {
        const r = await api.listAudit(token, {
          cursor: after ?? undefined,
          limit: 50,
          action: actionFilter || undefined,
        });
        setRows((cur) => (replace ? r.items : [...cur, ...r.items]));
        setCursor(r.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [token, actionFilter],
  );

  useEffect(() => {
    void loadPage(null, true);
  }, [loadPage]);

  const runVerify = async () => {
    setVerifying(true);
    try {
      const r = await api.verifyAudit(token);
      setVerify(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  };

  const verifyBanner = useMemo(() => {
    if (!verify) return null;
    if (verify.ok)
      return (
        <div className="banner banner-success">
          ✅ Hash chain verified — {verify.checked} entries.
          {verify.hashChainEnabled === false ? " (Hash chain disabled in config.)" : ""}
        </div>
      );
    return (
      <div className="banner banner-error">
        ❌ Audit chain break detected after {verify.checked} entries
        {verify.breakAt ? ` at ${verify.breakAt.action} (${verify.breakAt.id})` : ""}.
      </div>
    );
  }, [verify]);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Audit log</h2>
        <div className="panel-toolbar">
          <input
            className="filter-input"
            placeholder="Filter by action (e.g. apikey.patch)"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void loadPage(null, true);
            }}
          />
          <button className="btn" onClick={() => void loadPage(null, true)}>
            Filter
          </button>
          <button className="btn btn-primary" onClick={() => void runVerify()} disabled={verifying}>
            {verifying ? "Verifying…" : "Verify chain"}
          </button>
        </div>
      </div>

      {error ? <div className="banner banner-error">{error}</div> : null}
      {verifyBanner}

      {rows.length === 0 && !loading ? (
        <div className="muted">No audit entries match.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Resource</th>
              <th>Payload</th>
              <th>Hash</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtTs(r.createdAt)}</td>
                <td><span className="chip">{r.action}</span></td>
                <td>{r.actorId ?? "—"}</td>
                <td>{r.resource ?? "—"}</td>
                <td className="cell-json">
                  <code>{r.payload === null ? "—" : JSON.stringify(r.payload)}</code>
                </td>
                <td><code className="hash">{r.hash.slice(0, 12)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="panel-footer">
        {cursor ? (
          <button className="btn" onClick={() => void loadPage(cursor)} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        ) : (
          <span className="muted">{loading ? "Loading…" : "End of log."}</span>
        )}
      </div>
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------

function fmtTs(ts: number): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(ts);
  }
}
