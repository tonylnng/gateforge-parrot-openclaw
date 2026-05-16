/**
 * Sidebar session list — pinned / recent / archived sections with inline
 * rename, pin/unpin, archive/unarchive and delete (crypto-shred).
 *
 * The component is presentation-only: every state-changing action is
 * delegated to props so the parent <Chat /> stays the single source of
 * truth for the conversation set + crypto context.
 *
 * Titles are decrypted client-side on first sight; we cache the
 * plaintext in a parent-supplied map, keyed by conversation id.
 */
import { useMemo, useState } from "react";
import type { ConversationRow, SessionFilter } from "../lib/api";

type Section = "pinned" | "recent" | "archived";

interface Props {
  conversations: ConversationRow[];
  activeId: string | null;
  filter: SessionFilter;
  /** Map of conversation.id -> decrypted plaintext title (or null). */
  titles: Record<string, string | null>;
  query: string;
  busyId: string | null;

  onSelect: (id: string) => void;
  onSearch: (q: string) => void;
  onFilterChange: (f: SessionFilter) => void;
  onNewSession: () => void | Promise<void>;
  onRename: (id: string, plaintextTitle: string) => void | Promise<void>;
  onTogglePin: (id: string, next: boolean) => void | Promise<void>;
  onToggleArchive: (id: string, next: boolean) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}

export function SessionList(props: Props) {
  const {
    conversations,
    activeId,
    filter,
    titles,
    query,
    busyId,
    onSelect,
    onSearch,
    onFilterChange,
    onNewSession,
    onRename,
    onTogglePin,
    onToggleArchive,
    onDelete,
  } = props;

  const sections = useMemo(() => groupAndFilter(conversations, titles, query, filter), [
    conversations,
    titles,
    query,
    filter,
  ]);

  return (
    <div className="session-list">
      <div className="sidebar-actions">
        <button className="btn btn-primary btn-block" onClick={() => void onNewSession()}>
          + New chat
        </button>
      </div>

      <div className="session-search">
        <input
          type="search"
          value={query}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
        />
      </div>

      <div className="session-tabs" role="tablist">
        {(["active", "pinned", "archived", "all"] as SessionFilter[]).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            className={`session-tab ${filter === f ? "active" : ""}`}
            onClick={() => onFilterChange(f)}
          >
            {f === "active" ? "Recent" : f === "pinned" ? "Pinned" : f === "archived" ? "Archived" : "All"}
          </button>
        ))}
      </div>

      <div className="conv-list">
        {sections.pinned.length === 0 && sections.recent.length === 0 && sections.archived.length === 0 ? (
          <p className="conv-empty">{query ? "No matches." : "No chats yet."}</p>
        ) : (
          <>
            <Section
              label="Pinned"
              visible={sections.pinned.length > 0}
              rows={sections.pinned}
              section="pinned"
              activeId={activeId}
              titles={titles}
              busyId={busyId}
              onSelect={onSelect}
              onRename={onRename}
              onTogglePin={onTogglePin}
              onToggleArchive={onToggleArchive}
              onDelete={onDelete}
            />
            <Section
              label="Recent"
              visible={sections.recent.length > 0}
              rows={sections.recent}
              section="recent"
              activeId={activeId}
              titles={titles}
              busyId={busyId}
              onSelect={onSelect}
              onRename={onRename}
              onTogglePin={onTogglePin}
              onToggleArchive={onToggleArchive}
              onDelete={onDelete}
            />
            <Section
              label="Archived"
              visible={sections.archived.length > 0}
              rows={sections.archived}
              section="archived"
              activeId={activeId}
              titles={titles}
              busyId={busyId}
              onSelect={onSelect}
              onRename={onRename}
              onTogglePin={onTogglePin}
              onToggleArchive={onToggleArchive}
              onDelete={onDelete}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface SectionProps {
  label: string;
  visible: boolean;
  rows: ConversationRow[];
  section: Section;
  activeId: string | null;
  titles: Record<string, string | null>;
  busyId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, plaintextTitle: string) => void | Promise<void>;
  onTogglePin: (id: string, next: boolean) => void | Promise<void>;
  onToggleArchive: (id: string, next: boolean) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}

function Section(p: SectionProps) {
  if (!p.visible) return null;
  return (
    <div className="session-section">
      <div className="session-section-label">{p.label}</div>
      {p.rows.map((c) => (
        <ConversationItem
          key={c.id}
          conv={c}
          active={c.id === p.activeId}
          decryptedTitle={p.titles[c.id]}
          busy={p.busyId === c.id}
          onSelect={p.onSelect}
          onRename={p.onRename}
          onTogglePin={p.onTogglePin}
          onToggleArchive={p.onToggleArchive}
          onDelete={p.onDelete}
        />
      ))}
    </div>
  );
}

interface ItemProps {
  conv: ConversationRow;
  active: boolean;
  decryptedTitle: string | null | undefined;
  busy: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, plaintextTitle: string) => void | Promise<void>;
  onTogglePin: (id: string, next: boolean) => void | Promise<void>;
  onToggleArchive: (id: string, next: boolean) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}

function ConversationItem(p: ItemProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  const display =
    p.decryptedTitle ??
    p.conv.title ??
    (p.conv.encryptedTitle ? "🔒 Encrypted" : "Untitled");

  function startRename(e: React.MouseEvent) {
    e.stopPropagation();
    setDraft(p.decryptedTitle ?? p.conv.title ?? "");
    setRenaming(true);
  }

  async function commitRename() {
    const trimmed = draft.trim();
    setRenaming(false);
    if (!trimmed || trimmed === (p.decryptedTitle ?? "")) return;
    await p.onRename(p.conv.id, trimmed);
  }

  function confirmDelete(e: React.MouseEvent) {
    e.stopPropagation();
    const label = p.decryptedTitle ?? p.conv.title ?? "this chat";
    if (window.confirm(`Delete "${label}"? Messages are crypto-shredded and cannot be recovered.`)) {
      void p.onDelete(p.conv.id);
    }
  }

  return (
    <div
      className={`conv-item ${p.active ? "active" : ""} ${p.busy ? "busy" : ""}`}
      onClick={() => !renaming && p.onSelect(p.conv.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!renaming && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          p.onSelect(p.conv.id);
        }
      }}
    >
      <div className="conv-row">
        {renaming ? (
          <input
            className="conv-rename"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="conv-title" title={display}>
            {p.conv.isPinned ? "📌 " : ""}
            {display}
          </span>
        )}
        <span className="conv-time">{relativeTime(p.conv.lastMessageAt ?? p.conv.updatedAt)}</span>
      </div>
      <div className="conv-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className="conv-action"
          title={p.conv.isPinned ? "Unpin" : "Pin"}
          onClick={() => void p.onTogglePin(p.conv.id, !p.conv.isPinned)}
          disabled={p.busy}
        >
          {p.conv.isPinned ? "Unpin" : "Pin"}
        </button>
        <button className="conv-action" title="Rename" onClick={startRename} disabled={p.busy}>
          Rename
        </button>
        <button
          className="conv-action"
          title={p.conv.isArchived ? "Unarchive" : "Archive"}
          onClick={() => void p.onToggleArchive(p.conv.id, !p.conv.isArchived)}
          disabled={p.busy}
        >
          {p.conv.isArchived ? "Unarchive" : "Archive"}
        </button>
        <button className="conv-action danger" title="Delete (crypto-shred)" onClick={confirmDelete} disabled={p.busy}>
          Delete
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface GroupedSections {
  pinned: ConversationRow[];
  recent: ConversationRow[];
  archived: ConversationRow[];
}

function groupAndFilter(
  rows: ConversationRow[],
  titles: Record<string, string | null>,
  query: string,
  filter: SessionFilter,
): GroupedSections {
  const q = query.trim().toLowerCase();
  const matches = (c: ConversationRow): boolean => {
    if (!q) return true;
    const t = (titles[c.id] ?? c.title ?? "").toLowerCase();
    return t.includes(q);
  };

  const visible = rows.filter(matches);
  const out: GroupedSections = { pinned: [], recent: [], archived: [] };

  for (const c of visible) {
    if (filter === "pinned") {
      if (c.isPinned && !c.isArchived) out.pinned.push(c);
      continue;
    }
    if (filter === "archived") {
      if (c.isArchived) out.archived.push(c);
      continue;
    }
    // "active" (recent) or "all"
    if (c.isArchived) {
      if (filter === "all") out.archived.push(c);
      continue;
    }
    if (c.isPinned) out.pinned.push(c);
    else out.recent.push(c);
  }

  const byRecency = (a: ConversationRow, b: ConversationRow) =>
    (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt);
  out.pinned.sort(byRecency);
  out.recent.sort(byRecency);
  out.archived.sort(byRecency);
  return out;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  return `${mo}mo`;
}
