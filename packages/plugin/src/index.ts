/**
 * GateForge Parrot — OpenClaw plugin entry point.
 *
 * This module is referenced by `openclaw.extensions` in `package.json`. The
 * OpenClaw runtime imports the default export and calls it. We expose:
 *
 *   - the channel-plugin definition (id, manifest reference, hooks)
 *   - a side-effecting `registerFull(api)` that wires HTTP routes, DB, and hooks
 *
 * The plugin coexists with the rest of OpenClaw's runtime in the same process,
 * so we share its HTTP listener. If the runtime later supports a richer
 * WS-route API we can drop our `startWebSocketServer` indirection.
 */
import type { OpenClawPluginApiLite, ParrotConfig } from "./types.js";
import { PLUGIN_ID, CHANNEL_ID } from "./types.js";
import { resolveConfig, ConfigError } from "./config.js";
import { makeLogger } from "./util/logger.js";
import { openDatabase, type DbHandle } from "./db/index.js";
import { registerHooks } from "./hooks/index.js";
import { registerHttp } from "./http/router.js";

// We intentionally import from `openclaw/plugin-sdk/plugin-entry` lazily so
// that consumers who only want the types from this package (e.g. our own
// tests) don't need OpenClaw installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _definePluginEntry: ((spec: any) => any) | null = null;
async function loadSdk(): Promise<typeof _definePluginEntry> {
  if (_definePluginEntry) return _definePluginEntry;
  try {
    // Provided by the OpenClaw host at runtime. The dynamic import + ts-ignore
    // pattern keeps the build independent of whether OpenClaw is installed in
    // the consumer's tree.
    // @ts-ignore
    const mod = await import("openclaw/plugin-sdk/plugin-entry");
    _definePluginEntry = mod.definePluginEntry ?? null;
  } catch {
    _definePluginEntry = (spec) => spec;
  }
  return _definePluginEntry;
}

interface RuntimeState {
  cfg: ParrotConfig;
  db: DbHandle;
}

let _state: RuntimeState | null = null;

async function bootstrap(api: OpenClawPluginApiLite): Promise<RuntimeState | null> {
  const logger = makeLogger(api.logger);
  // Pull the plugin's section from the host config tree.
  // The OpenClaw runtime convention is plugins.entries.<id> for plugin config.
  // We tolerate the alternative shape `plugins.<id>` too.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rootCfg: any = api.runtime?.config ?? {};
  const rawCfg =
    rootCfg?.plugins?.entries?.[PLUGIN_ID] ?? rootCfg?.plugins?.[PLUGIN_ID] ?? rootCfg?.[PLUGIN_ID] ?? {};

  let cfg: ParrotConfig;
  try {
    cfg = resolveConfig(rawCfg);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(`Configuration invalid: ${err.message}`);
    } else {
      logger.error(`Configuration failed: ${(err as Error).message}`);
    }
    return null;
  }

  if (!cfg.enabled) {
    logger.info("Plugin disabled via config.enabled = false");
    return null;
  }

  let db: DbHandle;
  try {
    db = await openDatabase(cfg, logger, api.runtime);
  } catch (err) {
    logger.error(`Failed to open database: ${(err as Error).message}`);
    return null;
  }
  logger.info(`Database ready (driver=${db.driver}, prefix=${db.prefix})`);

  registerHttp({ api, cfg, db, logger });
  registerHooks({ api, cfg, db, logger });

  logger.info(`GateForge Parrot 🦜 loaded — channel='${CHANNEL_ID}', tenancy=${cfg.tenancy.mode}`);
  return { cfg, db };
}

const PLUGIN_SPEC = {
  id: PLUGIN_ID,
  name: "GateForge Parrot",
  description: "Zero-knowledge E2EE chat channel for OpenClaw.",
  async register(api: OpenClawPluginApiLite) {
    const state = await bootstrap(api);
    if (state) _state = state;
  },
};

// Default export wired via the OpenClaw SDK when available; otherwise raw spec.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entry: Promise<any> = loadSdk().then((define) => (define ? define(PLUGIN_SPEC) : PLUGIN_SPEC));
export default entry;

/** Expose internal state for tests and CLI scripts. Not part of public API. */
export function __getState(): RuntimeState | null {
  return _state;
}

export { PLUGIN_ID, CHANNEL_ID };
export type { ParrotConfig } from "./types.js";
