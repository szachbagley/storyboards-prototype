import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CONCEPT_TYPES, type ConceptType } from "@storyboards/shared";
import { ApiError, api } from "../api.js";
import { ImageTile } from "../components/ImageTile.js";
import { useApi } from "../hooks.js";

export function Concepts() {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.listConcepts(), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<ConceptType>("character");
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setCreateError(null);
    try {
      const concept = await api.createConcept({ name: name.trim(), type });
      navigate(`/concepts/${concept.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <>
      <div className="spread" style={{ marginBottom: 18 }}>
        <h1>Concepts</h1>
        <span className="muted">{data ? `${data.length} concept${data.length === 1 ? "" : "s"}` : ""}</span>
      </div>

      {error && (
        <div className="error-banner">
          {error} <button className="btn btn-small" onClick={reload}>Retry</button>
        </div>
      )}

      {creating && (
        <form className="row" onSubmit={onCreate} style={{ marginBottom: 18 }}>
          <input
            type="text"
            value={name}
            autoFocus
            placeholder="Concept name"
            aria-label="Concept name"
            style={{ maxWidth: 260 }}
            onChange={(e) => setName(e.target.value)}
          />
          <select value={type} aria-label="Concept type" style={{ maxWidth: 150 }} onChange={(e) => setType(e.target.value as ConceptType)}>
            {CONCEPT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <button className="btn btn-primary" type="submit" disabled={saving || !name.trim()}>Create</button>
          <button className="btn" type="button" onClick={() => { setCreating(false); setName(""); }}>Cancel</button>
          {createError && <span className="error-banner" style={{ margin: 0 }}>{createError}</span>}
        </form>
      )}

      {loading && !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="grid">
          {/* Leading "+" tile, per TECH_SPEC.md section 12.1. */}
          <button className="tile-add" type="button" aria-label="New concept" onClick={() => setCreating(true)}>+</button>
          {(data ?? []).map((concept) => (
            <Link key={concept.id} className="tile" to={`/concepts/${concept.id}`}>
              <ImageTile src={concept.imageUrl} alt={concept.name} empty="No reference" />
              <div className="tile-label">{concept.name}</div>
              <div className="tile-sub">{concept.type}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
