import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is served from `/gateforge-parrot/ui/` by the plugin's static file handler in
// production. We set `base` accordingly so generated asset URLs are correct.
export default defineConfig({
  plugins: [react()],
  base: "/gateforge-parrot/ui/",
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
      "/gateforge-parrot/api": "http://localhost:18789",
      "/gateforge-parrot/ws": { target: "ws://localhost:18789", ws: true },
    },
  },
});
