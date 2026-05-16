/**
 * Main chat view: sidebar with conversations + message panel.
 *
 * All message text is encrypted client-side before being sent and decrypted
 * client-side after being received. The server only sees ciphertext.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { decrypt, encrypt, generateMessageKey, unwrapKey, wrapKey } from "../lib/crypto";
import { useStore } from "../lib/store";

interface ConversationRow {
  id: string;
  title: string | null;
  encryptedTitle: string | null;
  wrappedConversationKey: string;
  createdAt: number;
  updatedAt: number;
}

interface DecodedMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  createdAt: number;
}

export function Chat() {
  const { accessToken, refreshToken, user, masterKey, logout: storeLogout } = useStore((s) => ({
    accessToken: s.accessToken!,
    refreshToken: s.refreshToken,
    user: s.user,
    masterKey: s.masterKey!,
    logout: s.logout,
  }));

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [convKey, setConvKey] = useState<CryptoKey | null>(null);
  const [messages, setMessages] = useState<DecodedMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);

  const activeConv = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);

  // -- Load conversations on mount ---------------------------------------
  useEffect(() => {
    let cancelled = false;
    api
      .listConversations(accessToken)
      .then((r) => {
        if (!cancelled) setConversations(r.conversations);
      })
      .catch((e: ApiError) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  // -- Unwrap conversation key & load messages when active changes -------
  useEffect(() => {
    if (!activeConv) {
      setMessages([]);
      setConvKey(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Unwrap conversation key with the master key (AES-KW).
        const ck = await unwrapKey(activeConv.wrappedConversationKey, masterKey);
        if (cancelled) return;
        setConvKey(ck);

        const r = await api.listMessages(accessToken, activeConv.id);
        if (cancelled) return;
        const decoded: DecodedMessage[] = [];
        for (const m of r.messages) {
          try {
            const text = await decrypt(m.ciphertext, ck);
            decoded.push({ id: m.id, role: m.role as DecodedMessage["role"], text, createdAt: m.createdAt });
          } catch {
            decoded.push({ id: m.id, role: m.role as DecodedMessage["role"], text: "[decryption failed]", createdAt: m.createdAt });
          }
        }
        if (!cancelled) setMessages(decoded);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConv, masterKey, accessToken]);

  // Scroll to bottom when new messages arrive.
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const newConversation = useCallback(async () => {
    setError(null);
    try {
      const ck = await generateMessageKey();
      const wrapped = await wrapKey(ck, masterKey);
      const r = await api.createConversation(accessToken, { title: "New chat", wrappedConversationKey: wrapped });
      const conv: ConversationRow = {
        id: r.conversation.id,
        title: "New chat",
        encryptedTitle: null,
        wrappedConversationKey: wrapped,
        createdAt: r.conversation.createdAt,
        updatedAt: r.conversation.updatedAt,
      };
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [accessToken, masterKey]);

  const send = useCallback(async () => {
    if (!activeConv || !convKey || !draft.trim()) return;
    setSending(true);
    setError(null);
    const text = draft;
    setDraft("");
    try {
      const ciphertext = await encrypt(text, convKey);
      const r = await api.appendMessage(accessToken, activeConv.id, { role: "user", ciphertext });
      setMessages((prev) => [...prev, { id: r.message.id, role: "user", text, createdAt: r.message.createdAt }]);
      // Phase 1 stops here: in Phase 2 we wire OpenClaw to produce an
      // `assistant` response and stream it back via WebSocket.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [activeConv, convKey, draft, accessToken]);

  async function logout() {
    try {
      if (refreshToken) await api.logout(refreshToken);
    } catch {
      /* best-effort */
    }
    storeLogout();
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="gf-parrot-logo" aria-hidden>🦜</span>
          <h1>Parrot</h1>
        </div>
        <div className="sidebar-actions">
          <button className="btn btn-primary btn-block" onClick={newConversation}>+ New chat</button>
        </div>
        <div className="conv-list">
          {conversations.length === 0 ? (
            <p style={{ padding: "0 12px", fontSize: 13, color: "var(--text-muted)" }}>No chats yet.</p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={`conv-item ${c.id === activeId ? "active" : ""}`}
                onClick={() => setActiveId(c.id)}
              >
                <span className="conv-title">{c.title ?? "Untitled"}</span>
                <span className="conv-time">{relativeTime(c.updatedAt)}</span>
              </div>
            ))
          )}
        </div>
        <div className="sidebar-footer">
          <div className="user-email">{user?.email}</div>
          <button className="btn btn-block" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <section className="main">
        <header className="main-header">
          <div>
            <div className="title">{activeConv?.title ?? "GateForge Parrot"}</div>
            <div className="subtitle">
              <span className="lock-icon">🔒 End-to-end encrypted</span>
              {user?.tenantId ? <span style={{ marginLeft: 8 }}>· workspace: {user.tenantId}</span> : null}
            </div>
          </div>
          {error ? <div className="auth-error" style={{ margin: 0, padding: "6px 10px", fontSize: 12 }}>{error}</div> : null}
        </header>

        {activeConv && convKey ? (
          <>
            <div className="messages">
              {messages.length === 0 ? (
                <div className="empty">
                  <h3>Start the conversation</h3>
                  <p>Type a message below. Messages are encrypted in this browser before they ever reach the server.</p>
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`bubble ${m.role}`}>
                    <div className="role">{m.role}</div>
                    {m.text}
                  </div>
                ))
              )}
              <div ref={messagesEnd} />
            </div>
            <div className="composer">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Type a message — Enter to send, Shift+Enter for newline"
                disabled={sending}
              />
              <button className="btn btn-primary" disabled={sending || !draft.trim()} onClick={() => void send()}>
                Send
              </button>
            </div>
          </>
        ) : (
          <div className="empty">
            <h3>Welcome 🦜</h3>
            <p>Select a chat on the left or start a new one.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
