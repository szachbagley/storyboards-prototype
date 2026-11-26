import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  MAX_CHARACTER_CONCEPTS,
  MAX_TOTAL_CONCEPTS,
  type ConceptDto,
  type FrameDto,
  type GenerationSummaryDto,
} from "@storyboards/shared";
import { ApiError, api } from "../api.js";
import { ConfirmButton } from "../components/ConfirmButton.js";
import { useApi } from "../hooks.js";
import { useAuth } from "../auth.js";
import { useFrameEdits } from "../useFrameEdits.js";
import { useFrameGeneration } from "../useFrameGeneration.js";

// A client can outlive an API rollback. Omitted response fields carry no
// evidence about the historical or current selection; explicit null does.
type HistoryContinuity = GenerationSummaryDto["continuity"] | null | undefined;
type CurrentSelection = Partial<Pick<FrameDto,
  "continuitySourceFrameId" | "continuitySourceSelectedGenerationId">>;

function ContinuityNote({ continuity, frame }: { continuity: HistoryContinuity; frame: CurrentSelection }) {
  const description = continuityDescription(continuity, frame);
  return description && <p className="muted">{description}</p>;
}

function continuityDescription(continuity: HistoryContinuity, frame: CurrentSelection): string | null {
  if (continuity == null) return "Continuity provenance unavailable.";
  if (continuity.provenance !== "known") {
    return continuity.provenance === "legacy" ? "Continuity provenance unavailable for this legacy generation." : "Continuity provenance unknown.";
  }
  const source = continuity.source;
  if (frame.continuitySourceFrameId === undefined || frame.continuitySourceSelectedGenerationId === undefined) {
    return source?.sourceFrameDeleted
      ? "Used deleted source frame. Current source selection unavailable."
      : "Current source selection unavailable.";
  }
  const differs = (source?.frameId ?? null) !== frame.continuitySourceFrameId ||
    (source?.generationId ?? null) !== frame.continuitySourceSelectedGenerationId;
  if (!differs) return source ? "Used current source selection." : null;
  const used = source?.sourceFrameDeleted ? "Used deleted source frame." :
    source ? "Used another source selection." : "Generated without a continuity source.";
  return used + " Current source selection differs; regenerate manually to use it.";
}

function RecoveredAttempt({ generation }: { generation: GenerationSummaryDto }) {
  let source = "Recorded source unavailable.";
  if (generation.continuity?.provenance === "known") {
    const recorded = generation.continuity.source;
    source = recorded
      ? `Recorded source frame ${recorded.frameId}, image generation ${recorded.generationId}.`
      : "This attempt used no continuity source.";
  }
  return <p role="status">Recovered generation {generation.status}. {source}</p>;
}

export function FrameEditor() {
  const { storyId = "", frameId = "" } = useParams();
  const { user } = useAuth();
  if (!user) return null;
  return <FrameEditorSession key={JSON.stringify([user.id, storyId, frameId])}
    userId={user.id} storyId={storyId} frameId={frameId} />;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Could not reach the server.";
}

function FrameEditorSession({ userId, storyId, frameId }: { userId: string; storyId: string; frameId: string }) {
  const navigate = useNavigate();
  const edits = useFrameEdits(frameId, storyId);
  const { frame } = edits;
  const attempt = useFrameGeneration(userId, frameId, frame, edits.reload);
  const conceptsState = useApi(() => api.listConcepts(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const controlLock = useRef(false);
  const admissionLock = useRef(false);
  const [admitting, setAdmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reviewedFrame, setReviewedFrame] = useState<FrameDto | null>(null);
  const [deleteReview, setDeleteReview] = useState<{ message: string; token: string; changed: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  if (!frame) return edits.readError
    ? <div className="error-banner">{edits.readError}</div>
    : <p className="muted">Loading…</p>;

  const description = edits.description.value;
  const attached = frame.concepts;
  const attachedIds = new Set(attached.map(c => c.id));
  const available = (conceptsState.data ?? []).filter(c => !attachedIds.has(c.id));
  const characterCount = attached.filter(c => c.type === "character").length;
  const recoveryOnly = attempt.canCheck && !attempt.canResubmit;
  const cannotGenerate = admitting || busy === "delete" || !!reviewedFrame || attempt.running ||
    attempt.checking || attempt.submitting || recoveryOnly || !description.trim();
  const controlsDisabled = admitting || busy !== null;
  const isGenerating = attempt.running && !attempt.timedOut;
  const failed = attempt.generation?.status === "failed" ? attempt.generation : null;

  function reportSaveError(error: unknown, intent: typeof edits.latest.current) {
    if (!edits.current()) return;
    if (error instanceof ApiError && (error.code === "continuity_configuration_changed" ||
        error.code === "invalid_continuity_source")) {
      setReviewedFrame(edits.latest.current.frame);
      edits.preserveIntent(intent);
    }
    setActionError(message(error));
  }

  function saveOnBlur() {
    const intent = edits.latest.current;
    if (admissionLock.current || reviewedFrame || !intent.description.dirty) return;
    setActionError(null);
    void edits.enqueue(async () => {
      await edits.save(intent, false);
      if (edits.current()) setSaved(true);
    }).catch(error => reportSaveError(error, intent));
  }

  async function onGenerate() {
    if (!edits.current() || admissionLock.current || cannotGenerate) return;
    const intent = edits.latest.current;
    admissionLock.current = true;
    setAdmitting(true);
    setActionError(null);
    try {
      await edits.enqueue(async () => {
        await edits.save(intent, true);
        if (!edits.current()) return;
        setSaved(true);
        await attempt.submit(intent.source.value);
      }, true);
    } catch (error) {
      reportSaveError(error, intent);
    } finally {
      admissionLock.current = false;
      if (edits.current()) setAdmitting(false);
    }
  }

  async function mutate(kind: string, work: () => Promise<void>) {
    if (!edits.current() || controlLock.current || admissionLock.current) return;
    controlLock.current = true;
    setBusy(kind);
    setActionError(null);
    try {
      await edits.enqueue(work);
    } catch (error) {
      if (edits.current()) setActionError(message(error));
    } finally {
      controlLock.current = false;
      if (edits.current()) setBusy(null);
    }
  }

  function resolveConflict(takeCurrent: boolean) {
    if (!frame || frame === reviewedFrame || controlsDisabled) return;
    const choice = takeCurrent ? frame.continuitySourceFrameId ?? null : edits.latest.current.source.value;
    edits.edit("source", choice);
    const intent = edits.latest.current;
    void mutate("review", async () => {
      try {
        await edits.save(intent, true);
        if (edits.current()) {
          setReviewedFrame(null);
          setSaved(true);
        }
      } catch (error) {
        reportSaveError(error, intent);
      }
    });
  }

  function setConcepts(ids: string[]) {
    return mutate("concepts", async () => { edits.merge(await api.updateFrame(frameId, { conceptIds: ids })); });
  }
  const attach = (concept: ConceptDto) => setConcepts([...attached.map(c => c.id), concept.id]);
  const detach = (id: string) => setConcepts(attached.filter(c => c.id !== id).map(c => c.id));
  const reorder = (index: number, delta: number) => {
    const ids = attached.map(c => c.id);
    const next = index + delta;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next]!, ids[index]!];
    return setConcepts(ids);
  };
  const onSelect = (id: string) => mutate("select", async () => {
    edits.merge(await api.selectGeneration(frameId, id));
  });

  const onDelete = (token?: string) => mutate("delete", async () => {
    try {
      await api.deleteFrame(frameId, token);
      if (edits.current()) navigate(`/stories/${storyId}`, { replace: true });
    } catch (err) {
      if (!edits.current()) return;
      if (err instanceof ApiError && err.status === 409 && err.code === "continuity_source_in_use" &&
          typeof err.details === "object" && err.details !== null &&
          "referencedByCount" in err.details && typeof err.details.referencedByCount === "number" &&
          "referenceSetToken" in err.details && typeof err.details.referenceSetToken === "string") {
        setDeleteReview({ message: err.message, token: err.details.referenceSetToken, changed: token !== undefined });
      } else {
        throw err;
      }
    }
  });

  const displayed = frame.generations.find((g) => g.id === frame.selectedGenerationId) ?? null;

  return (
    <>
      <div className="spread" style={{ marginBottom: 18 }}>
        <div className="row">
          <Link to={`/stories/${storyId}`} className="back" aria-label="Back to story">‹</Link>
          <h1>Frame</h1>
        </div>
        {deleteReview ? (
          <div>
            {deleteReview.changed && <p>The frames using this source have changed. Review the updated warning and confirm again.</p>}
            <p>{deleteReview.message}</p>
            <div className="row">
              <button className="btn btn-danger" type="button" disabled={controlsDisabled} onClick={() => void onDelete(deleteReview.token)}>Confirm deletion</button>
              <button className="btn" type="button" disabled={controlsDisabled} onClick={() => { setDeleteReview(null); setActionError(null); }}>Cancel</button>
            </div>
          </div>
        ) : <ConfirmButton key={frameId} label="Delete frame" confirmLabel="Delete frame permanently" busy={controlsDisabled} onConfirm={() => void onDelete()} />}
      </div>

      {actionError && <div className="error-banner">{actionError}</div>}

      {edits.readError && <div className="error-banner">{edits.readError} <button className="btn" onClick={edits.reload}>Refresh frame</button></div>}
      {reviewedFrame && <div className="error-banner">
        <p>Review the source before generating. Your scene draft has been kept.</p>
        {frame !== reviewedFrame && <>
          <p>Intended source: {edits.source.value ?? "None"}. Current source: {frame.continuitySourceFrameId ?? "None"}.</p>
          <button className="btn" disabled={controlsDisabled} onClick={() => resolveConflict(true)}>Use current source</button>
          <button className="btn" disabled={controlsDisabled} onClick={() => resolveConflict(false)}>Keep intended source</button>
        </>}
      </div>}
      {attempt.storageWarning && <p role="status">{attempt.storageWarning}</p>}
      {attempt.notice && <p role="status">{attempt.notice}</p>}
      {attempt.recovered && attempt.generation && <RecoveredAttempt generation={attempt.generation} />}
      {attempt.timedOut && <p role="status">This generation may still finish. Check again for its latest status.</p>}
      {attempt.canCheck && <button className="btn" disabled={attempt.checking || admitting} onClick={attempt.check}>
        {attempt.timedOut ? "Check again" : "Check request"}
      </button>}

      <div className="frame-layout">
        <div>
          {isGenerating ? (
            <div className="frame-placeholder">
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>Generating… {attempt.elapsedSeconds}s</p>
                <p className="muted" style={{ marginBottom: 0 }}>10 to 40 seconds is normal.</p>
              </div>
            </div>
          ) : displayed?.imageUrl ? (
            <img className="frame-image" src={displayed.imageUrl} alt="Generated frame" />
          ) : (
            <div className="frame-placeholder">Not generated yet</div>
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
              <button className="btn" type="button" onClick={onGenerate} disabled={cannotGenerate}>Retry</button>
            </div>
          )}

          <div className="spread" style={{ margin: "18px 0 8px" }}>
            <h2 style={{ margin: 0 }}>Scene description</h2>
            {saved && !edits.description.dirty && !edits.source.dirty && <span className="saved">Saved</span>}
          </div>
          <textarea
            value={description}
            aria-label="Frame description"
            placeholder="What happens in this frame — action, staging, camera, light, and any visual style. The attached concepts supply how the subjects look."
            disabled={admitting}
            onChange={(e) => { edits.edit("description", e.target.value); setSaved(false); }}
            onBlur={saveOnBlur}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn btn-primary" type="button" disabled={cannotGenerate} onClick={onGenerate}>
              {attempt.canResubmit ? "Resubmit request" : isGenerating ? "Generating…" : "Generate frame"}
            </button>
            {!description.trim() && <span className="muted">A description is required.</span>}
          </div>

          {frame.generations.length > 0 && (
            <>
              <h2 style={{ marginTop: 24 }}>History</h2>
              <div className="history">
                {frame.generations.map((g) => (
                  <div key={g.id}>
                    <button
                      type="button"
                      className={`history-item${g.id === frame.selectedGenerationId ? " history-selected" : ""}`}
                      disabled={controlsDisabled || g.status !== "succeeded"}
                      title={g.status === "succeeded" ? "Use this generation" : (g.errorCode ?? g.status)}
                      onClick={() => void onSelect(g.id)}
                    >
                      {g.imageUrl ? (
                        <img className="history-thumb" src={g.imageUrl} alt="Previous generation" />
                      ) : (
                        <div className="history-failed">{g.status === "pending" ? "…" : (g.errorCode ?? "failed")}</div>
                      )}
                    </button>
                    <ContinuityNote continuity={g.continuity} frame={frame} />
                  </div>
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
                  <button className="btn btn-small" type="button" aria-label={`Move ${concept.name} up`} disabled={controlsDisabled || index === 0} onClick={() => void reorder(index, -1)}>↑</button>
                  <button className="btn btn-small" type="button" aria-label={`Move ${concept.name} down`} disabled={controlsDisabled || index === attached.length - 1} onClick={() => void reorder(index, 1)}>↓</button>
                  <button className="btn btn-small" type="button" aria-label={`Remove ${concept.name}`} disabled={controlsDisabled} onClick={() => void detach(concept.id)}>×</button>
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
                  <button className="btn btn-small" type="button" disabled={controlsDisabled} onClick={() => void attach(concept)}>Attach</button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </>
  );
}
