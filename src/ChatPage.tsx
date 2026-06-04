import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  PatientListItem,
  ResearchQueryRequest,
  SSEEvent,
  streamResearchQuery,
} from "./api";
import PatientPickerModal from "./PatientPickerModal";

interface Props {
  token: string;
  userId: string;
  onLogout: () => void;
}

interface Turn {
  id: string;
  question: string;
  cohortIds: string[];
  events: SSEEvent[];
  status: "streaming" | "done" | "error";
}

export default function ChatPage({ token, userId, onLogout }: Props) {
  // Cohort selection is now structured: PatientListItem[] (from the picker
  // modal) rather than a raw text field of UUIDs. Display labels come for
  // free; we also still ship the ids list as the cohort.ids payload.
  const [cohort, setCohort] = useState<PatientListItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [question, setQuestion] = useState<string>("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll to the bottom on every event.
  useEffect(() => {
    if (!transcriptRef.current) return;
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [turns]);

  // Cancel any in-flight stream on unmount.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function handleSend(ev: React.FormEvent) {
    ev.preventDefault();
    const cohortIds = cohort.map((p) => p.patient_id);
    const q = question.trim();
    if (!q) return;
    if (cohortIds.length === 0) {
      // Surface error inline as an error turn instead of throwing.
      setTurns((prev) => [
        ...prev,
        {
          id: cryptoRandomId(),
          question: q,
          cohortIds: [],
          status: "error",
          events: [
            {
              event: "error",
              data: {
                message:
                  "Choose at least one patient above before asking a question.",
              },
            },
          ],
        },
      ]);
      return;
    }

    const turnId = cryptoRandomId();
    const turn: Turn = {
      id: turnId,
      question: q,
      cohortIds,
      events: [],
      status: "streaming",
    };
    setTurns((prev) => [...prev, turn]);
    setQuestion("");
    setBusy(true);

    const ac = new AbortController();
    abortRef.current = ac;

    // Build conversation history from prior turns. Concatenate any token
    // events into the assistant's reply for that turn. Cap at last 6 turns
    // (3 round-trips) to keep payload small and the LLM cost bounded.
    const history: { role: "user" | "assistant"; content: string }[] = [];
    for (const t of turns.slice(-6)) {
      if (t.status === "error") continue;
      history.push({ role: "user", content: t.question });
      const assistantText = t.events
        .filter((e) => e.event === "token")
        .map((e) =>
          typeof e.data === "string" ? e.data : (e.data?.delta ?? ""),
        )
        .join("");
      if (assistantText.trim()) {
        history.push({ role: "assistant", content: assistantText });
      }
    }

    const req: ResearchQueryRequest = {
      question: q,
      cohort: { kind: "ids", ids: cohortIds },
      history,
    };

    try {
      for await (const event of streamResearchQuery(req, token, ac.signal)) {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === turnId
              ? { ...t, events: [...t.events, event] }
              : t,
          ),
        );
        if (event.event === "done" || event.event === "error") {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === turnId
                ? {
                    ...t,
                    status: event.event === "error" ? "error" : "done",
                  }
                : t,
            ),
          );
        }
      }
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId && t.status === "streaming"
            ? { ...t, status: "done" }
            : t,
        ),
      );
    } catch (e) {
      const err = e as ApiError | DOMException;
      const message =
        err instanceof DOMException && err.name === "AbortError"
          ? "Stream aborted."
          : (err as ApiError).message ?? "Stream failed.";
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId
            ? {
                ...t,
                status: "error",
                events: [
                  ...t.events,
                  { event: "error", data: { message } },
                ],
              }
            : t,
        ),
      );
    } finally {
      setBusy(false);
      if (abortRef.current === ac) abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  return (
    <div className="chat-shell">
      <div className="topbar">
        <div className="brand">Research Agent</div>
        <div className="user">
          <span title={userId}>provider · {shortId(userId)}</span>
          <button className="logout" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </div>

      <div className="transcript" ref={transcriptRef}>
        {turns.length === 0 ? (
          <div className="empty">
            Pick a cohort below, then ask a research question.
            <br />
            Try: <em>"How many had a hypo event this week?"</em>
          </div>
        ) : (
          turns.map((turn) => <TurnView key={turn.id} turn={turn} />)
        )}
      </div>

      <form className="composer" onSubmit={handleSend}>
        <div className="cohort-strip">
          <button
            type="button"
            className="cohort-btn"
            onClick={() => setPickerOpen(true)}
            disabled={busy}
          >
            {cohort.length === 0 ? "Choose patients…" : "Edit cohort"}
          </button>
          <div className="cohort-chips" aria-label="Selected patients">
            {cohort.length === 0 ? (
              <span className="cohort-empty">no patients selected</span>
            ) : (
              <>
                {cohort.slice(0, 6).map((p) => (
                  <span key={p.patient_id} className="chip">
                    <span className="chip-name">
                      {chipLabel(p)}
                    </span>
                    <button
                      type="button"
                      className="chip-x"
                      aria-label="Remove"
                      title="Remove from cohort"
                      onClick={() =>
                        setCohort((prev) =>
                          prev.filter((q) => q.patient_id !== p.patient_id),
                        )
                      }
                      disabled={busy}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {cohort.length > 6 && (
                  <span className="chip more">
                    +{cohort.length - 6} more
                  </span>
                )}
                <button
                  type="button"
                  className="linklike clear-all"
                  onClick={() => setCohort([])}
                  disabled={busy}
                >
                  Clear all
                </button>
              </>
            )}
          </div>
        </div>
        <div className="row">
          <textarea
            placeholder={
              cohort.length === 0
                ? "Choose patients above, then ask a research question…"
                : "Ask a research question across this cohort…"
            }
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                handleSend(e as unknown as React.FormEvent);
              }
            }}
            disabled={busy}
          />
          {busy ? (
            <button type="button" className="send" onClick={handleStop}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="send"
              disabled={!question.trim() || cohort.length === 0}
            >
              Ask
            </button>
          )}
        </div>
      </form>

      {pickerOpen && (
        <PatientPickerModal
          token={token}
          initialSelectedIds={cohort.map((p) => p.patient_id)}
          initialKnownPatients={cohort}
          onClose={() => setPickerOpen(false)}
          onConfirm={(selected) => {
            setCohort(selected);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

// Compact chip label: prefer "First L." then fall back to short UUID.
function chipLabel(p: PatientListItem): string {
  const name = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  if (name) return name;
  return p.patient_id.length > 8 ? `${p.patient_id.slice(0, 8)}…` : p.patient_id;
}

// ── Turn / event rendering ────────────────────────────────────────────────

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className="turn">
      <div className="turn-question">
        <span className="label">
          You · {turn.cohortIds.length} patient
          {turn.cohortIds.length === 1 ? "" : "s"}
        </span>
        {turn.question}
      </div>
      <div className="events">
        {turn.events.map((e, i) => (
          <EventRow key={i} event={e} />
        ))}
        {turn.status === "streaming" && (
          <div className="event status">
            <span className="tag">…</span>
            <span className="body">streaming…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: SSEEvent }) {
  const cls = `event ${event.event}`;
  switch (event.event) {
    case "status":
      return (
        <div className={cls}>
          <span className="tag">status</span>
          <span className="body">
            {event.data?.stage ?? "?"}
            {event.data?.message ? ` — ${event.data.message}` : ""}
          </span>
        </div>
      );

    case "intent":
      return (
        <div className={cls}>
          <span className="tag">intent</span>
          <span className="body">
            {event.data?.intent}
            {event.data?.criteria_count != null
              ? ` · ${event.data.criteria_count} criterion${event.data.criteria_count === 1 ? "" : "a"}`
              : ""}
            {event.data?.combinator && event.data.criteria_count > 1
              ? ` · ${event.data.combinator}`
              : ""}
            {event.data?.fallback ? " · ⚠ fallback" : ""}
          </span>
        </div>
      );

    case "tool_call":
      return (
        <div className={cls}>
          <span className="tag">tool</span>
          <span className="body">
            {event.data?.tool}({summarizeArgs(event.data?.args)})
          </span>
        </div>
      );

    case "tool_result":
      return (
        <div className={cls}>
          <span className="tag">result</span>
          <span className="body">{event.data?.summary}</span>
        </div>
      );

    case "funnel_step":
      // Multiple funnel_step events render as a tight visual group.
      // Each row is its own event; the CSS makes them sit together.
      return (
        <div className={cls}>
          <span className="tag">funnel</span>
          <span className="body">
            {event.data?.step} →{" "}
            <strong style={{ color: "var(--funnel)" }}>
              {event.data?.count}
            </strong>
          </span>
        </div>
      );

    case "token": {
      const delta =
        typeof event.data === "string"
          ? event.data
          : (event.data?.delta ?? "");
      return (
        <div className={cls}>
          <span className="tag">answer</span>
          <span className="body">{delta}</span>
        </div>
      );
    }

    case "done":
      return (
        <div className={cls}>
          <span className="tag">done</span>
          <span className="body">
            <div>finished</div>
            <div className="done-meta">
              {event.data?.cost_usd != null && (
                <span>${event.data.cost_usd.toFixed(4)}</span>
              )}
              {event.data?.latency_ms != null && (
                <span>{event.data.latency_ms} ms</span>
              )}
              {event.data?.model_id && <span>{event.data.model_id}</span>}
              {event.data?.data?.final_count != null && (
                <span>final={event.data.data.final_count}</span>
              )}
              {event.data?.data?.path && (
                <span>via {event.data.data.path}</span>
              )}
            </div>
          </span>
        </div>
      );

    case "error":
      return (
        <div className={cls}>
          <span className="tag">error</span>
          <span className="body">
            {event.data?.message ?? "Unknown error"}
            {event.data?.fallback_text ? (
              <div style={{ marginTop: 6, opacity: 0.8 }}>
                {event.data.fallback_text}
              </div>
            ) : null}
          </span>
        </div>
      );

    default:
      return (
        <div className={cls}>
          <span className="tag">{event.event}</span>
          <span className="body">{JSON.stringify(event.data)}</span>
        </div>
      );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function summarizeArgs(args: any): string {
  if (!args) return "";
  if (Array.isArray(args)) return `[${args.length}]`;
  const parts: string[] = [];
  if (args.cohort_size != null) parts.push(`cohort=${args.cohort_size}`);
  if (Array.isArray(args.criteria))
    parts.push(`criteria=${args.criteria.length}`);
  if (args.condition) parts.push(`condition="${args.condition}"`);
  if (parts.length === 0) {
    // Fall back to compact JSON of top-level scalar keys.
    const scalar: Record<string, any> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v !== "object") scalar[k] = v;
    }
    return Object.entries(scalar)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  }
  return parts.join(", ");
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function cryptoRandomId(): string {
  // crypto.randomUUID is available in all modern browsers; fall back if not.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
