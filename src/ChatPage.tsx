import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, cohortQuery } from "./api";

interface Props {
  token: string;
  userId: string;
  onLogout: () => void;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "How many patients are under my care, and what's the age and gender breakdown?",
  "How many of my patients are in the diabetes range by GMI? Top 10 with estimated A1c.",
  "Who had sudden blood-sugar spikes this week, ranked by peak glucose?",
  "Who logs their meals most regularly this month?",
];

export default function ChatPage({ token, onLogout }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Opaque agent conversation state carried between turns (not shown).
  const [history, setHistory] = useState<unknown[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    setMessages((m) => [...m, { role: "user", content: q }]);
    setInput("");
    setBusy(true);
    try {
      const res = await cohortQuery(token, q, history);
      setHistory(res.history);
      setMessages((m) => [...m, { role: "assistant", content: res.answer }]);
    } catch (err) {
      setError((err as ApiError).message ?? "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-wrap">
      <header className="chat-header">
        <span className="chat-title">AIHealth Cohort Agent</span>
        <button className="linklike" onClick={onLogout}>
          Sign out
        </button>
      </header>

      <div className="chat-log">
        {messages.length === 0 && (
          <div className="empty">
            <p>Ask a research question across your patient panel.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="msg-role">{m.role === "user" ? "You" : "Agent"}</div>
            <div className="msg-body">
              {m.role === "assistant" ? (
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                </div>
              ) : (
                m.content
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="msg assistant">
            <div className="msg-role">Agent</div>
            <div className="msg-body thinking">analyzing your panel…</div>
          </div>
        )}
        {error && <div className="chat-error">Error: {error}</div>}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder="Ask about your patients…  (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? "…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
