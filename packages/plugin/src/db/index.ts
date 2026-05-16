/**
 * Database bootstrap. Detects driver (PostgreSQL or SQLite), opens a
 * connection, and exposes a Drizzle instance plus the typed schema for the
 * resolved table-name prefix.
 *
 * If `database.driver === "auto"`, we try to inherit OpenClaw's driver from
 * its runtime config; otherwise default to SQLite at `./gateforge-parrot.db`.
 */
import path from "node:path";
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import Database from "better-sqlite3";
import { Pool } from "pg";

import { buildPostgresSchema, buildSqliteSchema } from "./schema.js";
import type { ParrotConfig, ParrotLogger } from "../types.js";
import { runMigrations } from "./migrate.js";

export type SchemaPg = ReturnType<typeof buildPostgresSchema>;
export type SchemaSqlite = ReturnType<typeof buildSqliteSchema>;

export interface DbHandle {
  driver: "postgres" | "sqlite";
  /** Drizzle DB instance. Driver-specific. */
  drizzle: NodePgDatabase<SchemaPg> | BetterSQLite3Database<SchemaSqlite>;
  schema: SchemaPg | SchemaSqlite;
  /** Raw client for low-level operations (migrations, transactions). */
  raw: Pool | Database.Database;
  prefix: string;
  /** Close the underlying connection. */
  close(): Promise<void>;
}

/**
 * Try to read OpenClaw's database driver from its runtime config object.
 * Best-effort: if we can't find anything recognisable, return undefined.
 */
function detectOpenClawDriver(openclawRuntime: unknown): "postgres" | "sqlite" | undefined {
  if (!openclawRuntime || typeof openclawRuntime !== "object") return undefined;
  const cfg = (openclawRuntime as { config?: { storage?: { driver?: string; url?: string } } }).config;
  const driver = cfg?.storage?.driver?.toLowerCase();
  if (driver === "postgres" || driver === "postgresql") return "postgres";
  if (driver === "sqlite") return "sqlite";
  const url = cfg?.storage?.url?.toLowerCase();
  if (url?.startsWith("postgres")) return "postgres";
  if (url?.startsWith("file:") || url?.endsWith(".db") || url?.endsWith(".sqlite")) return "sqlite";
  return undefined;
}

export async function openDatabase(
  cfg: ParrotConfig,
  logger: ParrotLogger,
  openclawRuntime?: unknown,
): Promise<DbHandle> {
  let driver: "postgres" | "sqlite";
  if (cfg.database.driver === "auto") {
    driver = detectOpenClawDriver(openclawRuntime) ?? "sqlite";
    logger.info(`Database driver auto-detected: ${driver}`);
  } else {
    driver = cfg.database.driver;
  }

  if (driver === "postgres") {
    const url = cfg.database.url ?? process.env.DATABASE_URL ?? process.env.GATEFORGE_PARROT_DATABASE_URL;
    if (!url) throw new Error("postgres driver selected but no database.url or DATABASE_URL provided");
    const pool = new Pool({ connectionString: url, max: 10 });
    const schema = buildPostgresSchema(cfg.database.schemaPrefix);
    const db = drizzlePg(pool, { schema });

    if (cfg.database.runMigrationsOnStart) {
      await runMigrations({ driver, raw: pool, prefix: cfg.database.schemaPrefix, logger });
    }

    return {
      driver,
      drizzle: db,
      schema,
      raw: pool,
      prefix: cfg.database.schemaPrefix,
      async close() {
        await pool.end();
      },
    };
  }

  // SQLite branch
  const url = cfg.database.url ?? process.env.GATEFORGE_PARROT_SQLITE_PATH ?? "file:./gateforge-parrot.db";
  const filePath = url.startsWith("file:") ? url.slice("file:".length) : url;
  const resolved = path.resolve(filePath);
  const sqlite = new Database(resolved);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const schema = buildSqliteSchema(cfg.database.schemaPrefix);
  const db = drizzleSqlite(sqlite, { schema });

  if (cfg.database.runMigrationsOnStart) {
    await runMigrations({ driver, raw: sqlite, prefix: cfg.database.schemaPrefix, logger });
  }

  return {
    driver,
    drizzle: db,
    schema,
    raw: sqlite,
    prefix: cfg.database.schemaPrefix,
    async close() {
      sqlite.close();
    },
  };
}
