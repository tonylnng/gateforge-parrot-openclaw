/**
 * Migration runner. We ship raw SQL migrations under `migrations/{sqlite,postgres}/`
 * and apply any not yet recorded in `<prefix>_migrations`.
 *
 * Migrations are deliberately simple: numeric-prefixed `.sql` files applied
 * in lexicographic order. Each file contains driver-specific DDL.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import type { Pool, PoolClient } from "pg";

import type { ParrotLogger } from "../types.js";

export interface MigrateArgs {
  driver: "postgres" | "sqlite";
  raw: Pool | Database.Database;
  prefix: string;
  logger: ParrotLogger;
}

/** Resolve migrations directory relative to the compiled output. */
function migrationsDir(driver: "postgres" | "sqlite"): string {
  // dist/db/migrate.js -> dist/.. -> package root -> migrations/<driver>
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "migrations", driver);
}

export async function runMigrations(args: MigrateArgs): Promise<void> {
  const { driver, raw, prefix, logger } = args;
  const dir = migrationsDir(driver);

  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch (err) {
    logger.warn(`No migrations directory found at ${dir} — skipping migrations.`);
    return;
  }

  if (files.length === 0) {
    logger.info("No migration files found.");
    return;
  }

  if (driver === "sqlite") await runSqliteMigrations(raw as Database.Database, prefix, dir, files, logger);
  else await runPgMigrations(raw as Pool, prefix, dir, files, logger);
}

async function runSqliteMigrations(
  db: Database.Database,
  prefix: string,
  dir: string,
  files: string[],
  logger: ParrotLogger,
): Promise<void> {
  const tableName = `${prefix}migrations`;
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${tableName} (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  );
  const applied = new Set(
    db
      .prepare(`SELECT id FROM ${tableName}`)
      .all()
      .map((r) => (r as { id: string }).id),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    logger.info(`Applying migration ${file}`);
    const txn = db.transaction(() => {
      db.exec(sql.replaceAll("{{prefix}}", prefix));
      db.prepare(`INSERT INTO ${tableName} (id, applied_at) VALUES (?, ?)`).run(file, Date.now());
    });
    txn();
  }
}

async function runPgMigrations(
  pool: Pool,
  prefix: string,
  dir: string,
  files: string[],
  logger: ParrotLogger,
): Promise<void> {
  const tableName = `${prefix}migrations`;
  const client: PoolClient = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${tableName} (
        id TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )`,
    );
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM ${tableName}`);
    const applied = new Set(rows.map((r) => r.id));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      logger.info(`Applying migration ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql.replaceAll("{{prefix}}", prefix));
        await client.query(`INSERT INTO ${tableName} (id, applied_at) VALUES ($1, $2)`, [file, Date.now()]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    client.release();
  }
}
