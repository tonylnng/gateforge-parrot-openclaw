/**
 * Audit log writer with optional hash-chain tamper evidence.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";

import type { DbHandle } from "../db/index.js";
import { nextAuditHash } from "../crypto/server.js";
import type { ParrotConfig } from "../types.js";

export interface AuditEntry {
  tenantId: string;
  actorId?: string;
  action: string;
  resource?: string;
  payload?: Record<string, unknown>;
}

export async function appendAudit(db: DbHandle, cfg: ParrotConfig, entry: AuditEntry): Promise<void> {
  if (!cfg.audit.enabled) return;
  const now = Date.now();
  const id = randomUUID();
  const payload = entry.payload ? JSON.stringify(entry.payload) : null;

  let prevHash: string | null = null;
  if (cfg.audit.hashChain) {
    prevHash = await readLatestHash(db, entry.tenantId);
  }
  const entryForHash = {
    tenantId: entry.tenantId,
    actorId: entry.actorId ?? null,
    action: entry.action,
    resource: entry.resource ?? null,
    payload: entry.payload ?? null,
    createdAt: now,
  };
  const hash = cfg.audit.hashChain ? nextAuditHash(prevHash, entryForHash) : "";

  // We rely on driver-tagged drizzle types; both branches accept the same insert shape.
  const auditTable = db.schema.auditLog;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db.drizzle as any).insert(auditTable).values({
    id,
    tenantId: entry.tenantId,
    actorId: entry.actorId ?? null,
    action: entry.action,
    resource: entry.resource ?? null,
    prevHash,
    hash,
    payload,
    createdAt: now,
  });
}

async function readLatestHash(db: DbHandle, tenantId: string): Promise<string | null> {
  const t = db.schema.auditLog;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db.drizzle as any)
    .select({ hash: t.hash })
    .from(t)
    .where(eq(t.tenantId, tenantId))
    .orderBy(desc(t.createdAt))
    .limit(1)) as Array<{ hash: string }>;
  return rows[0]?.hash ?? null;
}
