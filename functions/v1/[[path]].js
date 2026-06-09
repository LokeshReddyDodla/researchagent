// Cloudflare Pages Function — proxies /v1/* to the AIHealth API.
//
// Why: a deployed static site has no Vite dev-proxy, so the browser's relative
// `/v1/...` calls would hit the static host (405) or, if pointed straight at
// api.aihealth.clinic, get CORS-blocked. This Function runs at the SAME origin
// as the site and forwards the request server-side, so the browser never makes
// a cross-origin request — no CORS, no backend change.
//
// Cloudflare Pages auto-deploys anything under functions/. This file handles
// every path under /v1/ (the [[path]] catch-all). Keep VITE_API_BASE_URL EMPTY
// so the app keeps using relative /v1 paths.

const API_ORIGIN = "https://api.aihealth.clinic";

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = API_ORIGIN + url.pathname + url.search;

  // Clone headers, forwarding auth (Authorization, x-device-id, Content-Type).
  // Drop Host so the runtime sets it to the API's host.
  const headers = new Headers(request.headers);
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  };

  return fetch(target, init);
}
