import { useEffect, useRef, useState } from "react";
import { ApiError, LoginResult, sendOtp, verifyOtp } from "./api";

interface Props {
  onLoggedIn: (auth: LoginResult) => void;
}

type Phase = "phone" | "otp";

// Resend cooldown: the SMS provider gets cranky if you spam send-otp.
const RESEND_COOLDOWN_SECONDS = 30;

export default function LoginPage({ onLoggedIn }: Props) {
  const [phase, setPhase] = useState<Phase>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const otpInputRef = useRef<HTMLInputElement>(null);

  // Tick down the resend cooldown.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // Auto-focus the OTP input when the second screen appears.
  useEffect(() => {
    if (phase === "otp") otpInputRef.current?.focus();
  }, [phase]);

  async function handleSendOtp(ev?: React.FormEvent) {
    if (ev) ev.preventDefault();
    if (!phone) return;
    setBusy(true);
    setError(null);
    setServerMessage(null);
    try {
      const msg = await sendOtp(phone.trim());
      setServerMessage(msg);
      setPhase("otp");
      setResendIn(RESEND_COOLDOWN_SECONDS);
    } catch (e) {
      const err = e as ApiError;
      setError(err.message ?? "Failed to send OTP.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyOtp(ev: React.FormEvent) {
    ev.preventDefault();
    if (!otp.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await verifyOtp(phone.trim(), otp.trim());
      onLoggedIn(result);
    } catch (e) {
      const err = e as ApiError;
      setError(err.message ?? "Invalid OTP.");
    } finally {
      setBusy(false);
    }
  }

  function handleBack() {
    setPhase("phone");
    setOtp("");
    setError(null);
    setServerMessage(null);
  }

  return (
    <div className="login-wrap">
      <form
        className="login-card"
        onSubmit={phase === "phone" ? handleSendOtp : handleVerifyOtp}
      >
        <h1>Research Agent</h1>
        <p className="subtitle">
          {phase === "phone"
            ? "Sign in with your care-provider phone number."
            : `Enter the OTP sent to ${phone}.`}
        </p>

        {phase === "phone" ? (
          <div className="field">
            <label htmlFor="phone">Phone number</label>
            <div className="phone-row">
              <span className="phone-prefix">+91</span>
              <input
                id="phone"
                type="tel"
                autoComplete="tel"
                inputMode="numeric"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="98765 43210"
                disabled={busy}
                required
              />
            </div>
            <div className="field-hint">
              India numbers only — country code added automatically.
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="otp">One-time code</label>
              <input
                id="otp"
                ref={otpInputRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 8))
                }
                placeholder="123456"
                disabled={busy}
                required
                style={{
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                  letterSpacing: "0.3em",
                  fontSize: "16px",
                  textAlign: "center",
                }}
              />
            </div>
            {serverMessage && (
              <div className="login-hint">{serverMessage}</div>
            )}
          </>
        )}

        <button
          type="submit"
          disabled={
            busy ||
            (phase === "phone" ? !phone.trim() : !otp.trim())
          }
        >
          {busy
            ? phase === "phone"
              ? "Sending…"
              : "Verifying…"
            : phase === "phone"
              ? "Send OTP"
              : "Verify & sign in"}
        </button>

        {phase === "otp" && (
          <div className="login-meta">
            <button
              type="button"
              className="linklike"
              onClick={handleBack}
              disabled={busy}
            >
              ← Change number
            </button>
            <button
              type="button"
              className="linklike"
              onClick={() => handleSendOtp()}
              disabled={busy || resendIn > 0}
            >
              {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend OTP"}
            </button>
          </div>
        )}

        {error && <div className="login-error">{error}</div>}
      </form>
    </div>
  );
}
