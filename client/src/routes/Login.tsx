import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError, api, setToken, clearToken } from "../api.js";
import { useAuth } from "../auth.js";

/** TECH_SPEC.md section 10: a single shared secret, stored in localStorage. */
export function Login() {
  const { secret, signIn } = useAuth();
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  if (secret) return <Navigate to="/concepts" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim() || checking) return;
    setChecking(true);
    setError(null);

    // Validate against a real authenticated endpoint before storing, so a wrong
    // secret is reported here rather than on the next navigation.
    setToken(value);
    try {
      await api.listConcepts();
      signIn(value);
      navigate("/concepts", { replace: true });
    } catch (err) {
      clearToken();
      setError(err instanceof ApiError && err.status === 401 ? "That secret was not accepted." : "Could not reach the API.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <form className="login" onSubmit={onSubmit}>
      <h1>Storyboards</h1>
      <p className="muted">Enter the shared secret to continue.</p>
      {error && <div className="error-banner">{error}</div>}
      <input
        type="password"
        value={value}
        autoFocus
        placeholder="Shared secret"
        aria-label="Shared secret"
        onChange={(e) => setValue(e.target.value)}
      />
      <button className="btn btn-primary" type="submit" disabled={checking || !value.trim()}>
        {checking ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}
