/**
 * Main chat view: sidebar SessionList + message panel.
 *
 * All message text *and* session titles are encrypted client-side before
 * being sent and decrypted client-side after being received. The server
 * never sees plaintext — only ciphertext envelopes (iv ‖ ct ‖ tag, base64).
 *
 * Conversation key lifecycle:
 *   - New chat: generate a random AES-256-GCM key, wrap with master key,
 *     send wrapped key with the create call.
 *   - Open chat: unwrap stored wrappedConversationKey with master key.
 *   - Rename: encrypt new title with conversation key, PATCH ciphertext.
 *   - Delete: server crypto-shreds (wipes messages + nulls wrapped key).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type ConversationRow, type SessionFilter } from "../lib/api";
import { decrypt, encrypt, generateMessageKey, unwrapKey, wrapKey } from "../lib/crypto";
import { useStore } from "../lib/store";
import { SessionList } from "../components/SessionList";

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
  const [filter, setFilter] = useState<SessionFilter>("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  /** id -> decrypted plaintext title (or null when no encrypted title set yet) */
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const messagesEnd = useRef<HTMLDivElement>(null);

  const activeConv = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);

  // -- Load conversations on mount / when filter changes -----------------
  useEffect(() => {
    let cancelled = false;
    api
      .listConversations(accessToken, filter)
      .then((r) => {
        if (!cancelled) setConversations(r.conversations);
      })
      .catch((e: ApiError) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [accessToken, filter]);

  // -- Decrypt titles as conversations arrive ----------------------------
  // For each row with an encryptedTitle we don't already have a plaintext
  // cached for, unwrap the conversation key and decrypt. This is a no-op
  // for rows whose plaintext is already known.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const c of conversations) {
        if (cancelled) return;
        if (titles[c.id] !== undefined) continue;
        if (!c.encryptedTitle) {
          setTitles((m) => ({ ...m, [c.id]: c.title ?? null }));
          continue;
        }
        try {
          const ck = await unwrapKey(c.wrappedConversationKey, masterKey);
          const plain = await decrypt(c.encryptedTitle, ck);
          if (!cancelled) setTitles((m) => ({ ...m, [c.id]: plain }));
        } catch {
          if (!cancelled) setTitles((m) => ({ ...m, [c.id]: null }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversations, masterKey, titles]);

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
            decoded.push({
              id: m.id,
              role: m.role as DecodedMessage["role"],
              text: "[decryption failed]",
              createdAt: m.createdAt,
            });
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

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // -- Mutations ---------------------------------------------------------

  const refreshOne = useCallback(
    async (id: string) => {
      // Cheap optimistic refresh: re-list with current filter so counts +
      // pin/archive flags stay in sync. The list is bounded server-side
      // so this is fine for now.
      try {
        const r = await api.listConversations(accessToken, filter);
        setConversations(r.conversations);
      } catch {
        /* ignore */
      }
      void id;
    },
    [accessToken, filter],
  );

  const newConversation = useCallback(async () => {
    setError(null);
    try {
      const ck = await generateMessageKey();
      const wrapped = await wrapKey(ck, masterKey);
      const plaintextTitle = "New chat";
      const encryptedTitle = await encrypt(plaintextTitle, ck);
      const r = await api.createConversation(
        accessToken,
        { encryptedTitle, wrappedConversationKey: wrapped },
        crypto.randomUUID(),
      );
      // Optimistic insert
      const conv: ConversationRow = {
        id: r.conversation.id,
        title: null,
        encryptedTitle,
        wrappedConversationKey: wrapped,
        agentId: null,
        isPinned: r.conversation.isPinned,
        isArchived: r.conversation.isArchived,
        pinnedAt: null,
        archivedAt: null,
        lastMessageAt: null,
        messageCount: r.conversation.messageCount,
        createdAt: r.conversation.createdAt,
        updatedAt: r.conversation.updatedAt,
      };
      setConversations((prev) => [conv, ...prev]);
      setTitles((m) => ({ ...m, [conv.id]: plaintextTitle }));
      setActiveId(conv.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [accessToken, masterKey]);

  const rename = useCallback(
    async (id: string, plaintextTitle: string) => {
      setError(null);
      const c = conversations.find((x) => x.id === id);
      if (!c) return;
      setBusyId(id);
      try {
        const ck = await unwrapKey(c.wrappedConversationKey, masterKey);
        const encryptedTitle = await encrypt(plaintextTitle, ck);
        await api.patchConversation(accessToken, id, { encryptedTitle });
        setConversations((prev) => prev.map((x) => (x.id === id ? { ...x, encryptedTitle, updatedAt: Date.now() } : x)));
        setTitles((m) => ({ ...m, [id]: plaintextTitle }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [accessToken, conversations, masterKey],
  );

  const togglePin = useCallback(
    async (id: string, next: boolean) => {
      setError(null);
      setBusyId(id);
      try {
        await api.patchConversation(accessToken, id, { isPinned: next });
        setConversations((prev) =>
          prev.map((x) => (x.id === id ? { ...x, isPinned: next, pinnedAt: next ? Date.now() : null } : x)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [accessToken],
  );

  const toggleArchive = useCallback(
    async (id: string, next: boolean) => {
      setError(null);
      setBusyId(id);
      try {
        await api.patchConversation(accessToken, id, { isArchived: next });
        // Refresh so archived items disappear from "active" view, etc.
        await refreshOne(id);
        if (next && activeId === id) setActiveId(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [accessToken, activeId, refreshOne],
  );

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      setBusyId(id);
      try {
        await api.deleteConversation(accessToken, id);
        setConversations((prev) => prev.filter((x) => x.id !== id));
        setTitles((m) => {
          const { [id]: _drop, ...rest } = m;
          void _drop;
          return rest;
        });
        if (activeId === id) setActiveId(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [accessToken, activeId],
  );

  const send = useCallback(async () => {
    if (!activeConv || !convKey || !draft.trim()) return;
    setSending(true);
    setError(null);
    const text = draft;
    setDraft("");
    try {
      const ciphertext = await encrypt(text, convKey);
      const r = await api.appendMessage(
        accessToken,
        activeConv.id,
        { role: "user", ciphertext },
        crypto.randomUUID(),
      );
      setMessages((prev) => [
        ...prev,
        { id: r.message.id, role: "user", text, createdAt: r.message.createdAt },
      ]);
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

  const activeTitle = activeConv ? titles[activeConv.id] ?? activeConv.title ?? "Untitled" : "GateForge Parrot";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="gf-parrot-logo" aria-hidden>🦜</span>
          <h1>Parrot</h1>
        </div>
        <SessionList
          conversations={conversations}
          activeId={activeId}
          filter={filter}
          titles={titles}
          query={searchQuery}
          busyId={busyId}
          onSelect={setActiveId}
          onSearch={setSearchQuery}
          onFilterChange={setFilter}
          onNewSession={newConversation}
          onRename={rename}
          onTogglePin={togglePin}
          onToggleArchive={toggleArchive}
          onDelete={remove}
        />
        <div className="sidebar-footer">
          <div className="user-email">{user?.email}</div>
          <button className="btn btn-block" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <section className="main">
        <header className="main-header">
          <div>
            <div className="title">{activeTitle}</div>
            <div className="subtitle">
              <span className="lock-icon">🔒 End-to-end encrypted</span>
              {user?.tenantId ? <span style={{ marginLeft: 8 }}>· workspace: {user.tenantId}</span> : null}
            </div>
          </div>
          {error ? (
            <div className="auth-error" style={{ margin: 0, padding: "6px 10px", fontSize: 12 }}>
              {error}
            </div>
          ) : null}
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
              <button
                className="btn btn-primary"
                disabled={sending || !draft.trim()}
                onClick={() => void send()}
              >
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
