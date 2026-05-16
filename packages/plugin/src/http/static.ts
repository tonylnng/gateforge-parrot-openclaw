/**
 * Static file server for the bundled React UI.
 * Looks for files under `<plugin-package>/ui-dist`.
 *
 * Falls back to `index.html` for SPA client-side routes.
 */
import { createReadStream, statSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HttpRequest, HttpResponse, ParrotLogger } from "../types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function uiRoot(): string {
  // dist/http/static.js -> dist/.. -> package root -> ui-dist
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "ui-dist");
}

export function makeStaticHandler(basePath: string, logger: ParrotLogger): (req: HttpRequest, res: HttpResponse) => boolean {
  const root = uiRoot();
  const hasBundle = existsSync(root) && existsSync(path.join(root, "index.html"));
  if (!hasBundle) {
    logger.warn(`UI bundle not found at ${root}. /gateforge-parrot/ui will serve a stub. Run 'npm run build:ui' in the source repo.`);
  }
  const indexHtml = hasBundle ? readFileSync(path.join(root, "index.html"), "utf8") : stubIndex();
  const normBase = basePath.replace(/\/+$/, "");

  return (req, res) => {
    if (!req.url.startsWith(normBase)) return false;

    const url = new URL(req.url, "http://placeholder");
    let rel = url.pathname.slice(normBase.length);
    if (rel === "" || rel === "/") rel = "/index.html";

    // Block path-traversal.
    if (rel.includes("..")) {
      res.statusCode = 400;
      res.end("bad path");
      return true;
    }

    const filePath = path.join(root, rel);
    if (hasBundle && existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.statusCode = 200;
      res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
      if (ext !== ".html") {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
      createReadStream(filePath).pipe(res as unknown as NodeJS.WritableStream);
      return true;
    }

    // SPA fallback: serve index.html (or stub) for unknown routes.
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.end(indexHtml);
    return true;
  };
}

function stubIndex(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>GateForge Parrot</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:64px auto;padding:0 24px;color:#1a1a1a}
h1{font-size:28px;margin-bottom:8px}h1::before{content:"🦜 "}code{background:#f4f4f5;padding:2px 6px;border-radius:4px}
.note{padding:16px;background:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px;margin:24px 0}</style>
</head><body>
<h1>GateForge Parrot</h1>
<p>The plugin is running, but the bundled UI was not built.</p>
<div class="note">Run <code>npm run build:ui</code> in the source repo, or visit the API at <code>/gateforge-parrot/api/v1/health</code>.</div>
<p>Docs: <a href="https://github.com/tonylnng/gateforge-parrot-openclaw">github.com/tonylnng/gateforge-parrot-openclaw</a></p>
</body></html>`;
}
