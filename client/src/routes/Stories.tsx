import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { ImageTile } from "../components/ImageTile.js";
import { useApi } from "../hooks.js";

export function Stories() {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.listStories(), []);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setCreateError(null);
    try {
      const story = await api.createStory({ title: title.trim() });
      navigate(`/stories/${story.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <>
      <div className="spread" style={{ marginBottom: 18 }}>
        <h1>Stories</h1>
        <span className="muted">{data ? `${data.length} stor${data.length === 1 ? "y" : "ies"}` : ""}</span>
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
            value={title}
            autoFocus
            placeholder="Story title"
            aria-label="Story title"
            style={{ maxWidth: 320 }}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={saving || !title.trim()}>Create</button>
          <button className="btn" type="button" onClick={() => { setCreating(false); setTitle(""); }}>Cancel</button>
          {createError && <span className="error-banner" style={{ margin: 0 }}>{createError}</span>}
        </form>
      )}

      {loading && !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="grid">
          <button className="tile-add" type="button" aria-label="New story" onClick={() => setCreating(true)}>+</button>
          {(data ?? []).map((story) => (
            <Link key={story.id} className="tile" to={`/stories/${story.id}`}>
              {/* Cover is the first frame's selected generation. */}
              <ImageTile src={story.coverImageUrl} alt={story.title} empty="No frames yet" />
              <div className="tile-label">{story.title}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
