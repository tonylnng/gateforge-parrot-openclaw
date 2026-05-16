import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is served from `/parrot/ui/` by the plugin's static file handler in
// production. We set `base` accordingly so generated asset URLs are correct.
export default defineConfig({
  plugins: [react()],
  base: "/parrot/ui/",
  build: {
    outDir: "dist",
    assetsInlineLimit: 4096,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: {
      // For local dev, proxy API to a locally-running OpenClaw on 18789.
      "/parrot/api": "http://localhost:18789",
      "/parrot/ws": { target: "ws://localhost:18789", ws: true },
    },
  },
});
