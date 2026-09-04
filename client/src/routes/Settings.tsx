import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { MIN_PASSWORD_LENGTH } from "@storyboards/shared";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";

export function Settings() {
  const { user, signOut, setUser } = useAuth();
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  if (!user) return null;

  function flash(message: string) {
    setSaved(message);
    setTimeout(() => setSaved(null), 2500);
  }

  async function onSaveKey(event: FormEvent) {
    event.preventDefault();
    if (!geminiApiKey.trim() || busy) return;
    setBusy("key");
    setError(null);
    try {
      // The server validates the key against Gemini before storing it, so a bad
      // key is reported here rather than on the next generation.
      setUser(await api.updateMe({ geminiApiKey: geminiApiKey.trim() }));
      setGeminiApiKey("");
      flash("API key updated");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onChangePassword(event: FormEvent) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH || password !== confirm || busy) return;
    setBusy("password");
    setError(null);
    try {
      setUser(await api.updateMe({ password }));
      setPassword("");
      setConfirm("");
      flash("Password changed — other sessions signed out");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="spread" style={{ marginBottom: 18 }}>
        <div className="row">
          <Link to="/concepts" className="back" aria-label="Back">‹</Link>
          <h1>Settings</h1>
        </div>
        <button className="btn" type="button" onClick={() => void signOut()}>Sign out</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {saved && <p className="saved">{saved}</p>}

      <div className="detail">
        <div>
          <h2>Account</h2>
          <p><strong>{user.username}</strong></p>
          <p className="muted">Joined {new Date(user.createdAt).toLocaleDateString()}</p>
        </div>

        <div>
          <h2>Gemini API key</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            {user.hasGeminiKey
              ? `A key ending in ${user.geminiKeyHint} is stored. It cannot be shown again — enter a new one to replace it.`
              : "No key stored. Descriptions and frames cannot be generated until you add one."}
          </p>
          <form className="row" onSubmit={onSaveKey}>
            <input
              type="password"
              value={geminiApiKey}
              placeholder="New Gemini API key"
              aria-label="New Gemini API key"
              style={{ maxWidth: 340 }}
              onChange={(e) => setGeminiApiKey(e.target.value)}
            />
            <button className="btn" type="submit" disabled={busy !== null || !geminiApiKey.trim()}>
              {busy === "key" ? "Checking…" : "Save key"}
            </button>
          </form>

          <h2 style={{ marginTop: 28 }}>Change password</h2>
          <form onSubmit={onChangePassword}>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              placeholder={`New password (at least ${MIN_PASSWORD_LENGTH} characters)`}
              aria-label="New password"
              style={{ marginBottom: 8 }}
              onChange={(e) => setPassword(e.target.value)}
            />
            <input
              type="password"
              value={confirm}
              autoComplete="new-password"
              placeholder="Confirm new password"
              aria-label="Confirm new password"
              onChange={(e) => setConfirm(e.target.value)}
            />
            {confirm.length > 0 && confirm !== password && <p className="warn">Passwords do not match.</p>}
            <button
              className="btn"
              type="submit"
              style={{ marginTop: 10 }}
              disabled={busy !== null || password.length < MIN_PASSWORD_LENGTH || password !== confirm}
            >
              {busy === "password" ? "Saving…" : "Change password"}
            </button>
            <p className="muted">Changing your password signs out every other device.</p>
          </form>
        </div>
      </div>
    </>
  );
}
