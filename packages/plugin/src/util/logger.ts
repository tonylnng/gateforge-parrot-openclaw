/** Minimal logger with structured prefix. Falls back to console.* */
import type { ParrotLogger } from "../types.js";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const levelRank: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const raw = (process.env.PARROT_LOG_LEVEL ?? "info").toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as Level) : "info";
}

/**
 * Wrap an optional host logger so messages are prefixed with `[parrot]`.
 * If no host logger is provided, falls back to console.
 */
export function makeLogger(host?: ParrotLogger): ParrotLogger {
  const min = levelRank[envLevel()];

  function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
    if (levelRank[level] < min) return;
    const prefixed = `[parrot] ${msg}`;
    if (host) {
      host[level](prefixed, meta);
      return;
    }
    const fn = level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;
    if (meta && Object.keys(meta).length > 0) fn(prefixed, meta);
    else fn(prefixed);
  }

  return {
    debug: (m, x) => emit("debug", m, x),
    info: (m, x) => emit("info", m, x),
    warn: (m, x) => emit("warn", m, x),
    error: (m, x) => emit("error", m, x),
  };
}
