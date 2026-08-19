import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  MAX_CHARACTER_CONCEPTS,
  MAX_TOTAL_CONCEPTS,
  type ConceptDto,
  type FrameDto,
} from "@storyboards/shared";
import { ApiError, api } from "../api.js";
import { ConfirmButton } from "../components/ConfirmButton.js";
import { useApi, useGenerationPolling } from "../hooks.js";

export function FrameEditor() {
  const { storyId = "", frameId = "" } = useParams();
  const navigate = useNavigate();
  const frameState = useApi(() => api.getFrame(frameId), [frameId]);
  const conceptsState = useApi(() => api.listConcepts(), []);

  const frame: FrameDto | null = frameState.data;
  const [description, setDescription] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generationId, setGenerationId] = useState<string | null>(null);

  const { generation, elapsedSeconds, timedOut } = useGenerationPolling(generationId);

  useEffect(() => {
    if (frame) setDescription(frame.description);
  }, [frame]);

  /**
   * Resume an in-flight generation on mount. Generation history is newest
   * first, so a pending newest generation means one is still running -- without
   * this a reload mid-generation would show idle while the work completed
   * invisibly, and pressing Generate again would only return 409.
   */
  useEffect(() => {
    if (!frame || generationId) return;
    const newest = frame.generations[0];
    if (newest?.status === "pending") setGenerationId(newest.id);
  }, [frame, generationId]);

  // A finished generation means the frame's image and history have changed.
  useEffect(() => {
    if (generation && generation.status !== "pending") frameState.reload();
    // Keyed on status alone: reloading whenever the generation object identity
    // changes would refetch on every poll tick.
  }, [generation?.status]);

  const attached = frame?.concepts ?? [];
  const attachedIds = useMemo(() => new Set(attached.map((c) => c.id)), [attached]);
  const available = (conceptsState.data ?? []).filter((c) => !attachedIds.has(c.id));
  const characterCount = attached.filter((c) => c.type === "character").length;

  if (frameState.loading && !frame) return <p className="muted">Loading…</p>;
  if (!frame) return <div className="error-banner">{frameState.error ?? "Not found"}</div>;

  async function saveDescription(next: string): Promise<void> {
    if (!frame || next === frame.description) return;
    await api.updateFrame(frame.id, { description: next });
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
    frameState.reload();
  }

  async function setConcepts(ids: string[]) {
    if (!frame) return;
    setBusy("concepts");
    setActionError(null);
    try {
      await api.updateFrame(frame.id, { conceptIds: ids });
      frameState.reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const attach = (concept: ConceptDto) => setConcepts([...attached.map((c) => c.id), concept.id]);
  const detach = (id: string) => setConcepts(attached.filter((c) => c.id !== id).map((c) => c.id));
  const reorder = (index: number, delta: number) => {
    const ids = attached.map((c) => c.id);
    const next = index + delta;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next]!, ids[index]!];
    return setConcepts(ids);
  };

  async function onGenerate() {
    if (!frame) return;
    setBusy("generate");
    setActionError(null);
    try {
      // Descriptions autosave on blur, but generating straight after typing must
      // not use a stale one -- and this is the operation that costs money.
      await saveDescription(description);
      const { generationId: id } = await api.generateFrame(frame.id);
      setGenerationId(id);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onSelect(id: string) {
    if (!frame) return;
    setBusy("select");
    try {
      await api.selectGeneration(frame.id, id);
      frameState.reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!frame) return;
    setBusy("delete");
    try {
      await api.deleteFrame(frame.id);
      navigate(`/stories/${storyId}`, { replace: true });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
      setBusy(null);
    }
  }

  // TECH_SPEC.md section 12.3: four distinct states.
  const isGenerating = generation?.status === "pending" || (generationId !== null && !generation && !timedOut);
  const failed = generation?.status === "failed" ? generation : null;
  const displayed = frame.generations.find((g) => g.id === frame.selectedGenerationId) ?? null;

  return (
    <>
      <div className="spread" style={{ marginBottom: 18 }}>
        <div className="row">
          <Link to={`/stories/${storyId}`} className="back" aria-label="Back to story">‹</Link>
          <h1>Frame</h1>
        </div>
        <ConfirmButton label="Delete frame" confirmLabel="Delete frame permanently" busy={busy === "delete"} onConfirm={onDelete} />
      </div>

      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="frame-layout">
        <div>
          {isGenerating ? (
            <div className="frame-placeholder">
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>Generating… {elapsedSeconds}s</p>
                <p className="muted" style={{ marginBottom: 0 }}>10 to 40 seconds is normal.</p>
              </div>
            </div>
          ) : displayed?.imageUrl ? (
            <img className="frame-image" src={displayed.imageUrl} alt="Generated frame" />
          ) : (
            <div className="frame-placeholder">Not generated yet</div>
          )}

          {timedOut && !failed && (
            <div className="error-banner" style={{ marginTop: 12 }}>
              This is taking longer than expected. It may still finish — reload to check.
            </div>
          )}

          {failed && (
            <div className="error-banner" style={{ marginTop: 12 }}>
              <strong>{failed.errorCode === "safety_blocked" ? "Content filter" : "Generation failed"}</strong>
              <p style={{ margin: "6px 0" }}>{failed.errorMessage}</p>
              {/* section 12.3: for safety_blocked the description stays editable in
                  place, which it is -- the textarea below is always live. */}
              {failed.errorCode === "safety_blocked" && (
                <p className="muted" style={{ color: "inherit" }}>Edit the description below and try again.</p>
              )}
              <button className="btn" type="button" onClick={onGenerate} disabled={busy === "generate"}>Retry</button>
            </div>
          )}

          <div className="spread" style={{ margin: "18px 0 8px" }}>
            <h2 style={{ margin: 0 }}>Scene description</h2>
            {saved && <span className="saved">Saved</span>}
          </div>
          <textarea
            value={description}
            aria-label="Frame description"
            placeholder="What happens in this frame — action, staging, camera, light, and any visual style. The attached concepts supply how the subjects look."
            onChange={(e) => setDescription(e.target.value)}
            onBlur={(e) => void saveDescription(e.target.value).catch(() => setActionError("Could not save the description."))}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn btn-primary" type="button" disabled={busy === "generate" || isGenerating || !description.trim()} onClick={onGenerate}>
              {isGenerating ? "Generating…" : "Generate frame"}
            </button>
            {!description.trim() && <span className="muted">A description is required.</span>}
          </div>

          {frame.generations.length > 0 && (
            <>
              <h2 style={{ marginTop: 24 }}>History</h2>
              <div className="history">
                {frame.generations.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={`history-item${g.id === frame.selectedGenerationId ? " history-selected" : ""}`}
                    disabled={busy === "select" || g.status !== "succeeded"}
                    title={g.status === "succeeded" ? "Use this generation" : (g.errorCode ?? g.status)}
                    onClick={() => void onSelect(g.id)}
                  >
                    {g.imageUrl ? (
                      <img className="history-thumb" src={g.imageUrl} alt="Previous generation" />
                    ) : (
                      <div className="history-failed">{g.status === "pending" ? "…" : (g.errorCode ?? "failed")}</div>
                    )}
                  </button>
                ))}
              </div>
              <p className="muted">Regenerating adds to this list; it never replaces the selected image.</p>
            </>
          )}
        </div>

        <aside>
          <h2>Concepts</h2>
          {/* section 8.3: surface remaining character slots rather than letting a
              user attach nine and receive slop. */}
          <p className="budget">
            <span className={characterCount >= MAX_CHARACTER_CONCEPTS ? "budget-full" : ""}>
              Characters {characterCount} / {MAX_CHARACTER_CONCEPTS}
            </span>
            {" · "}
            <span className={attached.length >= MAX_TOTAL_CONCEPTS ? "budget-full" : ""}>
              Total {attached.length} / {MAX_TOTAL_CONCEPTS}
            </span>
          </p>

          {attached.length === 0 ? (
            <p className="muted">None attached.</p>
          ) : (
            <ul className="picker-list">
              {attached.map((concept, index) => (
                <li key={concept.id} className="picker-item">
                  {/* The index is shown because it becomes frame_concepts.ord,
                      which becomes the reference-image enumeration order. */}
                  <span className="picker-ord">{index + 1}.</span>
                  <span className="picker-name">
                    {concept.name} <span className="muted">{concept.type}</span>
                    {!concept.imageUrl && <span className="warn"> · no reference image</span>}
                  </span>
                  <button className="btn btn-small" type="button" aria-label={`Move ${concept.name} up`} disabled={busy !== null || index === 0} onClick={() => void reorder(index, -1)}>↑</button>
                  <button className="btn btn-small" type="button" aria-label={`Move ${concept.name} down`} disabled={busy !== null || index === attached.length - 1} onClick={() => void reorder(index, 1)}>↓</button>
                  <button className="btn btn-small" type="button" aria-label={`Remove ${concept.name}`} disabled={busy !== null} onClick={() => void detach(concept.id)}>×</button>
                </li>
              ))}
            </ul>
          )}

          <h2 style={{ marginTop: 20 }}>Add</h2>
          {available.length === 0 ? (
            <p className="muted">Nothing left to attach.</p>
          ) : (
            <ul className="picker-list">
              {available.map((concept) => (
                <li key={concept.id} className="picker-item">
                  <span className="picker-name">
                    {concept.name} <span className="muted">{concept.type}</span>
                  </span>
                  <button className="btn btn-small" type="button" disabled={busy !== null} onClick={() => void attach(concept)}>Attach</button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </>
  );
}
