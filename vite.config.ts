import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy: the browser only talks to http://localhost:5173.
// Vite forwards /v1/* and /docs to the aihealth-server backend
// (default http://localhost:8000, override via VITE_API_PROXY_TARGET).
//
// This is the project-sanctioned approach — aihealth-server's CLAUDE.md
// forbids adding new CORS origins to middleware_setup.py, and routing
// through Vite avoids the browser's preflight entirely.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_PROXY_TARGET ?? "http://localhost:8000";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/v1": {
          target,
          changeOrigin: true,
          // Keep the path as-is. /v1/auth/send-otp → {target}/v1/auth/send-otp
        },
        "/docs": {
          target,
          changeOrigin: true,
        },
        "/openapi.json": {
          target,
          changeOrigin: true,
        },
      },
    },
  };
});
