import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { positionBetween, type FrameSummaryDto } from "@storyboards/shared";
import { ApiError, api } from "../api.js";
import { ConfirmButton } from "../components/ConfirmButton.js";
import { ImageTile } from "../components/ImageTile.js";
import { useApi } from "../hooks.js";

export function StoryDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const story = useApi(() => api.getStory(id), [id]);
  const frames = useApi(() => api.listStoryFrames(id), [id]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const list: FrameSummaryDto[] = frames.data ?? [];

  async function onAddFrame() {
    setBusy(true);
    setActionError(null);
    try {
      const frame = await api.createFrame(id, {});
      navigate(`/stories/${id}/frames/${frame.id}`);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  /**
   * Reordering (TECH_SPEC.md section 5.2), using the pure helper from shared/
   * that phase 4 built and tested for exactly this caller.
   *
   * Only the moved frame's position is written -- that is the whole reason
   * position is a DOUBLE PRECISION rather than a sequence integer. The
   * "Frame N" labels are derived from array order, so they renumber themselves.
   */
  async function move(index: number, direction: "left" | "right") {
    const target = list[index];
    if (!target) return;
    const position =
      direction === "left"
        ? positionBetween(list[index - 2]?.position ?? null, list[index - 1]!.position)
        : positionBetween(list[index + 1]!.position, list[index + 2]?.position ?? null);

    setBusy(true);
    setActionError(null);
    try {
      await api.updateFrame(target.id, { position });
      frames.reload();
      story.reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteStory() {
    setBusy(true);
    try {
      await api.deleteStory(id);
      navigate("/stories", { replace: true });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="spread" style={{ marginBottom: 18 }}>
        <div className="row">
          <Link to="/stories" className="back" aria-label="Back to stories">‹</Link>
          <h1>{story.data?.title ?? "…"}</h1>
          <span className="muted">{list.length} frame{list.length === 1 ? "" : "s"}</span>
        </div>
        <ConfirmButton
          label="Delete story"
          confirmLabel="Delete story and all its frames"
          busy={busy}
          onConfirm={onDeleteStory}
        />
      </div>

      {(actionError ?? frames.error) && <div className="error-banner">{actionError ?? frames.error}</div>}

      {frames.loading && !frames.data ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="grid">
          {list.map((frame, index) => (
            <div key={frame.id}>
              <Link className="tile" to={`/stories/${id}/frames/${frame.id}`}>
                <ImageTile src={frame.imageUrl} alt={`Frame ${index + 1}`} empty="Not generated" />
                {/* Labels are derived from position order at render time and are
                    never stored (TECH_SPEC.md section 5.2). */}
                <div className="tile-label">Frame {index + 1}</div>
                <div className="tile-sub">{frame.description ? frame.description.slice(0, 48) : "No description"}</div>
              </Link>
              <div className="tile-controls">
                <button
                  className="btn btn-small"
                  type="button"
                  aria-label={`Move frame ${index + 1} left`}
                  disabled={busy || index === 0}
                  onClick={() => void move(index, "left")}
                >
                  ←
                </button>
                <button
                  className="btn btn-small"
                  type="button"
                  aria-label={`Move frame ${index + 1} right`}
                  disabled={busy || index === list.length - 1}
                  onClick={() => void move(index, "right")}
                >
                  →
                </button>
              </div>
            </div>
          ))}
          {/* Trailing "+" tile, per TECH_SPEC.md section 12.1. */}
          <button className="tile-add" type="button" aria-label="Add frame" disabled={busy} onClick={onAddFrame}>+</button>
        </div>
      )}
    </>
  );
}
