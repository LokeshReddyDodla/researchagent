import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// Same-origin proxy: the browser only ever talks to the page's own origin
// (http://localhost:5173). Vite forwards /v1/*, /docs and /openapi.json to
// the aihealth-server backend, so the browser never makes a cross-origin
// request and there is no CORS preflight to be rejected.
//
// This is the project-sanctioned approach — aihealth-server's CLAUDE.md
// forbids adding new CORS origins to middleware_setup.py, so routing through
// this proxy is the only way the frontend can reach the API.
//
// IMPORTANT: this proxy must be applied to BOTH `server` (npm run dev) and
// `preview` (npm run preview / serving the production build). Vite's
// `server.proxy` does NOT carry over to preview — without a `preview.proxy`
// block the built app's /v1 calls hit the static server instead of the
// backend and login silently fails.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  // Default to the hosted backend so the app works out of the box even if
  // .env.local is missing or wasn't reloaded. Override with
  // VITE_API_PROXY_TARGET=http://localhost:8000 to hit a local backend.
  const target = env.VITE_API_PROXY_TARGET || "https://api.aihealth.clinic";

  const proxy: Record<string, string | ProxyOptions> = {
    // changeOrigin rewrites the Host header (and TLS SNI) to the target,
    // which Cloudflare in front of api.aihealth.clinic requires.
    "/v1": { target, changeOrigin: true },
    "/docs": { target, changeOrigin: true },
    "/openapi.json": { target, changeOrigin: true },
  };

  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { port: 5173, proxy },
  };
});
