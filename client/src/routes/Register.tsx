import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { MIN_PASSWORD_LENGTH, USERNAME_MIN_LENGTH } from "@storyboards/shared";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";

export function Register() {
  const { user, loading, signIn } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [signupCode, setSignupCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  if (user) return <Navigate to="/concepts" replace />;

  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    username.trim().length >= USERNAME_MIN_LENGTH &&
    password.length >= MIN_PASSWORD_LENGTH &&
    confirm === password &&
    geminiApiKey.trim().length > 0;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const { token, user: created } = await api.register({
        username: username.trim(),
        password,
        geminiApiKey: geminiApiKey.trim(),
        ...(signupCode.trim() ? { signupCode: signupCode.trim() } : {}),
      });
      signIn(token, created);
      navigate("/concepts", { replace: true });
    } catch (err) {
      // The server validates the Gemini key before creating anything, so a bad
      // key surfaces here rather than on the first generation.
      setError(err instanceof ApiError ? err.message : "Could not reach the API.");
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={onSubmit}>
      <h1>Create an account</h1>
      {error && <div className="error-banner">{error}</div>}

      <input
        type="text"
        value={username}
        autoFocus
        autoComplete="username"
        placeholder="Username"
        aria-label="Username"
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        type="password"
        value={password}
        autoComplete="new-password"
        placeholder={`Password (at least ${MIN_PASSWORD_LENGTH} characters)`}
        aria-label="Password"
        onChange={(e) => setPassword(e.target.value)}
      />
      <input
        type="password"
        value={confirm}
        autoComplete="new-password"
        placeholder="Confirm password"
        aria-label="Confirm password"
        onChange={(e) => setConfirm(e.target.value)}
      />
      {mismatch && <p className="warn">Passwords do not match.</p>}

      <input
        type="password"
        value={geminiApiKey}
        placeholder="Gemini API key"
        aria-label="Gemini API key"
        onChange={(e) => setGeminiApiKey(e.target.value)}
      />
      <p className="muted">
        Your own key pays for your image and description generation. Get one free at{" "}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          aistudio.google.com/apikey
        </a>
        . It is encrypted before it is stored and is never shown again.
      </p>

      <input
        type="text"
        value={signupCode}
        placeholder="Invite code (only if you were given one)"
        aria-label="Invite code"
        onChange={(e) => setSignupCode(e.target.value)}
      />

      <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
        {busy ? "Checking your key…" : "Create account"}
      </button>
      <p className="muted">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </form>
  );
}
