#!/usr/bin/env node
/**
 * OpenAPI drift check.
 *
 * Compares the operations declared in `packages/plugin/openapi.yaml`
 * against the routes wired in `packages/plugin/src/http/router.ts`.
 * Designed to be cheap, no-deps, and easy to read — not a full
 * validator.
 *
 * Exits non-zero if the two views drift. CI runs this on every PR.
 *
 * Conventions:
 *   - The router prefixes every API route with `${apiBase}` which is
 *     `/gateforge-parrot/api/v1` in production. The OpenAPI spec
 *     declares paths relative to that base, so we strip the prefix
 *     before comparing.
 *   - Code uses Express-style `:id`, spec uses OpenAPI `{id}`. Both
 *     are normalised to `:x` for the diff.
 *   - Public, non-API routes (UI static handler, CORS preflight) are
 *     ignored — they have no business in the spec.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const SPEC = resolve(repo, "packages/plugin/openapi.yaml");
const ROUTER = resolve(repo, "packages/plugin/src/http/router.ts");

if (!existsSync(SPEC) || !existsSync(ROUTER)) {
  console.error("[drift] missing spec or router file");
  process.exit(2);
}

const spec_text = readFileSync(SPEC, "utf8");
const router_text = readFileSync(ROUTER, "utf8");

// ---------- 1) collect paths declared in OpenAPI -------------------
// Top-level `paths:` then 2-space-indented `/...:` lines, then verbs.

/** @type {Map<string, Set<string>>} */
const spec_routes = new Map();
{
  const lines = spec_text.split("\n");
  let in_paths = false;
  let current = null;
  for (const raw of lines) {
    if (/^paths:\s*$/.test(raw)) { in_paths = true; continue; }
    if (in_paths && /^[A-Za-z]/.test(raw)) break; // left the `paths:` block
    if (!in_paths) continue;

    const m_path = raw.match(/^  (\/[^:\s]+):\s*$/);
    if (m_path) {
      current = m_path[1];
      if (!spec_routes.has(current)) spec_routes.set(current, new Set());
      continue;
    }
    const m_verb = raw.match(/^    (get|post|put|patch|delete|head|options):\s*$/i);
    if (m_verb && current) {
      spec_routes.get(current).add(m_verb[1].toUpperCase());
    }
  }
}

// ---------- 2) collect routes wired in router.ts -------------------
// Parse `registerHttpRoute({ path: ..., method: "...", ...})` blocks.

/** @type {Map<string, Set<string>>} */
const code_routes = new Map();
{
  const re = /registerHttpRoute\(\{\s*([\s\S]*?)\}\)/g;
  let m;
  while ((m = re.exec(router_text))) {
    const body = m[1];
    const p_m = body.match(/path:\s*`([^`]+)`/) || body.match(/path:\s*["']([^"']+)["']/);
    const v_m = body.match(/method:\s*["']([A-Z]+)["']/);
    if (!p_m || !v_m) continue;

    // Strip the `${apiBase}` template prefix; the spec is relative to it.
    let raw_path = p_m[1].replace(/\$\{apiBase\}/, "");

    // Routes that aren't part of the JSON API surface.
    //   * UI static handler lives under cfg.ui.basePath, not apiBase.
    //   * /openapi.yaml is the spec itself.
    //   * CORS preflight wildcard.
    if (raw_path.includes("${cfg.ui.basePath")) continue;
    if (raw_path === "/openapi.yaml") continue;
    if (raw_path === "/*" && v_m[1] === "OPTIONS") continue;

    if (!code_routes.has(raw_path)) code_routes.set(raw_path, new Set());
    code_routes.get(raw_path).add(v_m[1]);
  }
}

// ---------- 3) diff ------------------------------------------------

const normalise = (p) => p.replace(/\{[^}]+\}/g, ":x").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":x");
const key = (m, p) => `${m} ${normalise(p)}`;

const spec_keys = new Set();
for (const [p, ms] of spec_routes) for (const ms2 of ms) spec_keys.add(key(ms2, p));

const code_keys = new Set();
for (const [p, ms] of code_routes) for (const ms2 of ms) code_keys.add(key(ms2, p));

const only_in_spec = [...spec_keys].filter((k) => !code_keys.has(k)).sort();
const only_in_code = [...code_keys].filter((k) => !spec_keys.has(k)).sort();

let bad = 0;
if (only_in_spec.length) {
  console.error("[drift] declared in openapi.yaml but NOT wired in router.ts:");
  for (const k of only_in_spec) console.error("  -", k);
  bad++;
}
if (only_in_code.length) {
  console.error("[drift] wired in router.ts but NOT declared in openapi.yaml:");
  for (const k of only_in_code) console.error("  -", k);
  bad++;
}

if (bad === 0) {
  console.log(`[drift] OK — ${spec_keys.size} operations in sync (spec) / ${code_keys.size} (router)`);
  process.exit(0);
} else {
  console.error(`[drift] FAIL — fix the items above`);
  process.exit(1);
}
