// API client for the aihealth-server research agent.
//
// Talks to two endpoints:
//   POST /v1/auth/care-provider/email-login   — JWT login for care providers
//   POST /v1/research-agent/query             — cohort question (SSE stream)
//
// SSE NOTE: the foundation server uses POST + Server-Sent Events, which
// EventSource doesn't support (it only does GET). We use the fetch API
// with a ReadableStream and parse the wire format ourselves.

// Empty default: requests go to the same origin (http://localhost:5173),
// which Vite proxies to the backend per vite.config.ts. Override
// VITE_API_BASE_URL only when you need to bypass the proxy.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

// ── Auth (phone + OTP) ────────────────────────────────────────────────────

export interface LoginResult {
  token: string;
  user_id: string;
  device_id: string | null;
}

export interface ApiError {
  message: string;
  status?: number;
  detail?: string;
}

// The role this app authenticates as. The research agent only accepts
// care_provider and admin; we always log in as care_provider.
const LOGIN_ROLE = "care_provider";

/** Normalize an Indian phone number to the format the backend expects:
 *  12 digits, no "+", no spaces, leading "91" country code.
 *  Accepts:  "9844272232", "+91 9844272232", "91-98442 72232", " 098442 72232 "
 *  Returns:  "919844272232"
 */
function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return digits;
}

/**
 * Request an OTP to be sent to the given phone number.
 *
 * Returns the server's message string. In dev builds the aihealth-server
 * embeds the OTP in the message text — we surface it so a tester sees it
 * without having to dig through logs. Strip this in prod.
 */
export async function sendOtp(phoneNumber: string): Promise<string> {
  const resp = await fetch(`${API_BASE_URL}/v1/auth/send-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone_number: normalizePhone(phoneNumber) }),
  });
  if (!resp.ok) {
    const body = await safeJson(resp);
    throw asApiError(resp, body, "Failed to send OTP");
  }
  const body = await resp.json();
  return body?.message ?? "OTP sent.";
}

/**
 * Verify the OTP and exchange it for a JWT.
 *
 * The server's verify-otp endpoint takes `role` as a query parameter
 * (not a body field) — we pin it to `care_provider` because the research
 * agent only allows that role and admin.
 */
export async function verifyOtp(
  phoneNumber: string,
  otp: string,
): Promise<LoginResult> {
  const url = `${API_BASE_URL}/v1/auth/verify-otp?role=${encodeURIComponent(LOGIN_ROLE)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone_number: normalizePhone(phoneNumber), otp }),
  });
  if (!resp.ok) {
    const body = await safeJson(resp);
    throw asApiError(resp, body, "OTP verification failed");
  }
  const body = await resp.json();
  const data = body?.data ?? body;
  if (!data?.token) {
    throw {
      message: "Verify-OTP response missing token",
      status: resp.status,
    } as ApiError;
  }
  return {
    token: data.token,
    user_id: data.user_id,
    device_id: data.device_id ?? null,
  };
}

// ── Patients (for the picker) ────────────────────────────────────────────

export interface PatientListItem {
  patient_id: string;
  first_name: string | null;
  last_name: string | null;
  last_active_at: string | null;
}

export interface PatientListResult {
  total: number;
  items: PatientListItem[];
}

/**
 * GET /v1/patients — returns patients accessible to the calling care provider.
 *
 * The backend automatically scopes to the actor's panel (it uses
 * `get_effective_care_provider_id(current_actor)` server-side), so care
 * providers see only their own patients. Admins see facility-wide.
 *
 * We project to a compact shape; the server returns much more per row,
 * but the picker only needs name + last-active.
 */
export async function listPatients(
  token: string,
  opts: { limit?: number; offset?: number; search?: string } = {},
): Promise<PatientListResult> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  if (opts.search) params.set("search", opts.search);
  // Sort by recently active first — most useful for the picker.
  params.set("order_by", "last_active_at");
  params.set("order", "desc");

  const url = `${API_BASE_URL}/v1/patients${params.toString() ? "?" + params : ""}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (!resp.ok) {
    const body = await safeJson(resp);
    throw asApiError(resp, body, "Failed to load patients");
  }
  const body = await resp.json();
  const data = body?.data ?? body;
  // The list may arrive under data.items / data.patients / data.results, or
  // as a bare array. Be liberal about where the rows live.
  const rawItems: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.patients)
        ? data.patients
        : Array.isArray(data?.results)
          ? data.results
          : [];
  const items: PatientListItem[] = rawItems.map(mapPatient);
  const total = Number(
    data?.total ?? data?.count ?? data?.total_count ?? items.length,
  );
  return { total, items };
}

/** Normalize one patient row from the list endpoint into our compact shape.
 *  The backend's list item isn't strictly typed in the OpenAPI spec, and the
 *  field names differ across deployments, so we probe a few common aliases:
 *    id:    patient_id | id | user_id | uid
 *    name:  first_name/last_name, else split full_name | name
 *    active: last_active_at | last_active | last_seen_at | updated_at
 *  The patient object may also be nested under `patient`/`profile`/`user`. */
function mapPatient(raw: any): PatientListItem {
  const it = raw?.patient ?? raw?.profile ?? raw?.user ?? raw ?? {};
  const id =
    it.patient_id ?? it.id ?? it.user_id ?? it.uid ?? raw?.patient_id ?? raw?.id;

  let first = it.first_name ?? null;
  let last = it.last_name ?? null;
  if (first == null && last == null) {
    const full = it.full_name ?? it.name ?? raw?.full_name ?? raw?.name;
    if (typeof full === "string" && full.trim()) {
      const parts = full.trim().split(/\s+/);
      first = parts[0] ?? null;
      last = parts.length > 1 ? parts.slice(1).join(" ") : null;
    }
  }

  return {
    patient_id: id != null ? String(id) : "",
    first_name: first,
    last_name: last,
    last_active_at:
      it.last_active_at ??
      it.last_active ??
      it.last_seen_at ??
      it.updated_at ??
      null,
  };
}

// ── Research agent SSE stream ─────────────────────────────────────────────

// Mirror of the SSEEventType enum the server emits in
// lib/ai_foundation/streaming/sse.py. We also accept the custom
// `funnel_step` event the research agent emits per criterion.
export type SSEEventName =
  | "status"
  | "intent"
  | "token"
  | "done"
  | "error"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "plan"
  | "reflection"
  | "specialist_start"
  | "specialist_done"
  | "funnel_step";

export interface SSEEvent {
  event: SSEEventName | string;
  data: any;
}

/** One prior conversation turn — the frontend keeps the thread in memory
 *  and sends the most recent turns with each request so the agent can
 *  resolve references like "those 17" to last turn's cohort. */
export interface ResearchHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ResearchQueryRequest {
  question: string;
  cohort:
    | { kind: "ids"; ids: string[] }
    | { kind: "saved"; cohort_id: string }
    | { kind: "panel" };
  history?: ResearchHistoryTurn[];
}

/**
 * Open a POST SSE connection to the research agent and yield parsed events
 * as they arrive. The async iterator returns when the stream ends or the
 * caller calls `controller.abort()`.
 *
 * Usage:
 *   const ac = new AbortController();
 *   for await (const ev of streamResearchQuery(req, token, ac.signal)) {
 *     // ev.event === "status" | "intent" | "token" | "done" | "error" | ...
 *   }
 */
export async function* streamResearchQuery(
  req: ResearchQueryRequest,
  token: string,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent, void, void> {
  const resp = await fetch(`${API_BASE_URL}/v1/research-agent/query`, {
    method: "POST",
    headers: authHeaders(token, {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    }),
    body: JSON.stringify(req),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const body = await safeJson(resp);
    throw asApiError(resp, body, "Research query failed");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  // Accumulator across chunk boundaries — SSE events can be split.
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines (\n\n). We pull complete
      // events out one at a time and leave the partial tail in `buffer`.
      let sepIdx: number;
      // eslint-disable-next-line no-cond-assign
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const parsed = parseSSEEvent(rawEvent);
        if (parsed) yield parsed;
      }
    }
    // Flush any final event that wasn't terminated by \n\n (rare but legal).
    if (buffer.trim()) {
      const parsed = parseSSEEvent(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* nothing */
    }
  }
}

function parseSSEEvent(raw: string): SSEEvent | null {
  // SSE wire format:
  //   event: <name>
  //   data: <json or text>
  //   data: <continuation>
  //
  // Comments start with ":" and are ignored. Empty events return null.
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join("\n");
  let data: any = dataStr;
  try {
    data = JSON.parse(dataStr);
  } catch {
    // Server sometimes emits plain strings for token deltas — leave as-is.
  }
  return { event: eventName, data };
}

// ── Utilities ────────────────────────────────────────────────────────────

async function safeJson(resp: Response): Promise<any> {
  try {
    return await resp.json();
  } catch {
    try {
      return { detail: await resp.text() };
    } catch {
      return {};
    }
  }
}

function asApiError(
  resp: Response,
  body: any,
  fallback: string,
): ApiError {
  const detail =
    typeof body?.detail === "string"
      ? body.detail
      : body?.detail
        ? JSON.stringify(body.detail)
        : body?.message;
  return {
    message: detail || `${fallback} (${resp.status})`,
    status: resp.status,
    detail,
  };
}

// ── Token storage ────────────────────────────────────────────────────────

const TOKEN_KEY = "ra.token";
const USER_KEY = "ra.user_id";
const DEVICE_KEY = "ra.device_id";

export function loadAuth(): {
  token: string;
  user_id: string;
  device_id: string | null;
} | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const user_id = localStorage.getItem(USER_KEY);
  if (!token || !user_id) return null;
  return { token, user_id, device_id: localStorage.getItem(DEVICE_KEY) };
}

export function saveAuth(auth: LoginResult): void {
  localStorage.setItem(TOKEN_KEY, auth.token);
  localStorage.setItem(USER_KEY, auth.user_id);
  // The backend issues a device_id on verify-otp and requires it back as
  // the `x-device-id` header on every authenticated request.
  if (auth.device_id) localStorage.setItem(DEVICE_KEY, auth.device_id);
  else localStorage.removeItem(DEVICE_KEY);
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(DEVICE_KEY);
}

/** Build the auth headers for an authenticated request: the bearer token
 *  plus the `x-device-id` the backend handed us at verify-otp time. The
 *  production API rejects calls missing `x-device-id`. */
function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
  const deviceId = localStorage.getItem(DEVICE_KEY);
  if (deviceId) headers["x-device-id"] = deviceId;
  return headers;
}

// ── Cohort Agent ───────────────────────────────────────────────────────────

export interface CohortAnswer {
  answer: string;
  /** Opaque agent conversation state to pass back on the next turn. */
  history: unknown[];
}

/**
 * Ask the cohort agent a free-form question across the care provider's panel.
 *
 * POST /v1/cohort-agent/query — non-streaming. The backend runs the agent
 * (scoped to this care provider) and returns the answer plus updated history.
 * Pass the previous turn's `history` for multi-turn context.
 */
export async function cohortQuery(
  token: string,
  message: string,
  history: unknown[] = [],
): Promise<CohortAnswer> {
  const resp = await fetch(`${API_BASE_URL}/v1/cohort-agent/query`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ message, history }),
  });
  if (!resp.ok) {
    const body = await safeJson(resp);
    throw asApiError(resp, body, "Cohort query failed");
  }
  const body = await resp.json();
  const data = body?.data ?? body;
  return { answer: data?.answer ?? "", history: data?.history ?? [] };
}
