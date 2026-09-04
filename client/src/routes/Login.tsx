import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";

export function Login() {
  const { user, loading, signIn } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  if (user) return <Navigate to="/concepts" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const { token, user: signedIn } = await api.login({ username: username.trim(), password });
      signIn(token, signedIn);
      navigate("/concepts", { replace: true });
    } catch (err) {
      // The server returns one message for an unknown username, a wrong
      // password and a locked account, so there is nothing to distinguish here.
      setError(err instanceof ApiError ? err.message : "Could not reach the API.");
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={onSubmit}>
      <h1>Storyboards</h1>
      <p className="muted">Sign in to your account.</p>
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
        autoComplete="current-password"
        placeholder="Password"
        aria-label="Password"
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="btn btn-primary" type="submit" disabled={busy || !username.trim() || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="muted">
        No account? <Link to="/register">Create one</Link>
      </p>
    </form>
  );
}
