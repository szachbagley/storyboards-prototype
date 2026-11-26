import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  MAX_CHARACTER_CONCEPTS,
  effectiveConceptLimit,
  CONTINUITY_REFERENCE_SLOTS,
  type FrameSummaryDto,
  type ConceptDto,
  type FrameDto,
  type GenerationSummaryDto,
} from "@storyboards/shared";
import { ApiError, api } from "../api.js";
import { ContinuityPicker, sourceReady } from "../components/ContinuityPicker.js";
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

function ContinuityNote({ continuity, frame, frames }: {
  continuity: HistoryContinuity; frame: CurrentSelection; frames: FrameSummaryDto[] | null;
}) {
  const source = continuity?.provenance === "known" ? continuity.source : null;
  const index = frames?.findIndex(candidate => candidate.id === source?.frameId) ?? -1;
  return <div className="provenance">
    <p>{continuityDescription(continuity, frame)}</p>
    {source && <details>
      <summary>{source.sourceFrameDeleted ? "Deleted source frame" : index >= 0 ? `Source frame ${index + 1}` : "Source frame"} details</summary>
      <p>Frame {source.frameId}<br />Image generation {source.generationId}</p>
    </details>}
  </div>;
}

function continuityDescription(continuity: HistoryContinuity, frame: CurrentSelection): string {
  if (continuity == null) return "Continuity provenance unavailable.";
  if (continuity.provenance !== "known") {
    return continuity.provenance === "legacy" ? "Continuity provenance unavailable for this legacy generation." : "Continuity provenance unknown.";
  }
  const source = continuity.source;
  if (frame.continuitySourceFrameId === undefined || frame.continuitySourceSelectedGenerationId === undefined) {
    if (!source) return "Generated without a continuity source. Current source selection unavailable.";
    return source.sourceFrameDeleted
      ? "Used deleted source frame. Current source selection unavailable."
      : "Current source selection unavailable.";
  }
  const differs = (source?.frameId ?? null) !== frame.continuitySourceFrameId ||
    (source?.generationId ?? null) !== frame.continuitySourceSelectedGenerationId;
  if (!differs) return source ? "Used current source selection." : "Generated without a continuity source.";
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
  const sourceId = edits.source.value;
  const enabled = frame.continuityEnabled === true;
  const limit = effectiveConceptLimit(sourceId !== null);
  const excessConcepts = Math.max(0, attached.length - limit);
  const excessCharacters = Math.max(0, characterCount - MAX_CHARACTER_CONCEPTS);
  const frameIndex = edits.sources?.findIndex(row => row.id === frameId) ?? -1;
  const selectedSource = edits.sources?.find(row => row.id === sourceId);
  const candidateError = edits.sourceListError ?? edits.readError;
  const sourceBlocked = sourceId !== null && (!enabled || !!candidateError || !sourceReady(selectedSource));
  const recoveryOnly = attempt.canCheck && !attempt.canResubmit;
  const cannotGenerate = admitting || busy === "delete" || !!reviewedFrame || attempt.running ||
    attempt.checking || attempt.submitting || recoveryOnly || !description.trim() ||
    sourceBlocked || excessConcepts > 0 || excessCharacters > 0;
  const controlsDisabled = admitting || busy !== null;
  const isGenerating = attempt.running && !attempt.timedOut;
  const failed = attempt.generation?.status === "failed" ? attempt.generation : null;

  function reportSaveError(error: unknown, intent: typeof edits.latest.current) {
    if (!edits.current() || edits.latest.current.source.sequence !== intent.source.sequence) return;
    if (error instanceof ApiError && (error.code === "continuity_configuration_changed" ||
        error.code === "invalid_continuity_source")) {
      setReviewedFrame(edits.latest.current.frame);
      edits.preserveIntent(intent);
    }
    if (error instanceof ApiError && (error.code === "continuity_unavailable" ||
        error.code === "continuity_source_unusable")) edits.reload();
    setActionError(message(error));
  }

  function saveDraft(refreshSources: boolean) {
    const intent = edits.latest.current;
    setActionError(null);
    void edits.enqueue(async () => {
      try {
        await edits.save(intent, false);
      } catch (error) {
        const latest = edits.latest.current;
        // A newer source pick queues its own save. Its result determines whether
        // a Generate waiting behind both writes can proceed.
        if (latest.source.sequence !== intent.source.sequence ||
            (!intent.source.dirty && latest.description.sequence !== intent.description.sequence)) return;
        throw error;
      }
      if (!edits.current()) return;
      const latest = edits.latest.current;
      if (latest.source.sequence === intent.source.sequence &&
          latest.description.sequence === intent.description.sequence) setSaved(true);
      if (refreshSources) edits.reload();
    }).catch(error => reportSaveError(error, intent));
  }

  function saveOnBlur() {
    if (admissionLock.current || reviewedFrame || !edits.latest.current.description.dirty) return;
    saveDraft(false);
  }

  function chooseSource(id: string | null) {
    if (admissionLock.current || controlLock.current || reviewedFrame) return;
    edits.edit("source", id);
    setSaved(false);
    saveDraft(true);
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
      await edits.enqueue(async () => {
        await work();
        if (kind !== "delete" && edits.latest.current.frame?.continuityEnabled) edits.reload();
      });
    } catch (error) {
      if (edits.current()) setActionError(message(error));
    } finally {
      controlLock.current = false;
      if (edits.current()) setBusy(null);
    }
  }

  function resolveConflict(choice: string | null) {
    if (!frame || frame === reviewedFrame || controlsDisabled) return;
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
          <h1>{frameIndex < 0 ? "Frame" : `Frame ${frameIndex + 1}`}</h1>
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
          {enabled ? <>
            <button className="btn" disabled={controlsDisabled} onClick={() => resolveConflict(frame.continuitySourceFrameId)}>Use current source</button>
            <button className="btn" disabled={controlsDisabled} onClick={() => resolveConflict(edits.source.value)}>Keep intended source</button>
          </> : <>
            <p>Continuity is unavailable. Clear the source to save this scene without it.</p>
            <button className="btn" disabled={controlsDisabled} onClick={() => resolveConflict(null)}>Clear source and save scene</button>
          </>}
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

          {displayed && (
            <section aria-label="Selected output" className="selected-output">
              <h2>Selected output</h2>
              <ContinuityNote continuity={displayed.continuity} frame={frame} frames={edits.sources} />
            </section>
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
          {enabled ? <ContinuityPicker targetId={frameId} sourceId={sourceId} frames={edits.sources}
            error={candidateError} disabled={controlsDisabled || !!reviewedFrame}
            onChange={chooseSource} refresh={edits.reload} />
          : sourceId && !reviewedFrame && <p className="source-unavailable">Continuity unavailable. Current source: {sourceId}.{" "}
              <button type="button" className="btn btn-small" disabled={controlsDisabled}
                onClick={() => chooseSource(null)}>Clear source</button>
            </p>}
          {edits.source.dirty && actionError && !reviewedFrame &&
            <button type="button" className="btn btn-small" disabled={controlsDisabled}
              onClick={() => chooseSource(sourceId)}>Retry source save</button>}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn btn-primary" type="button" disabled={cannotGenerate} onClick={onGenerate}>
              {attempt.canResubmit ? "Resubmit request" : isGenerating ? "Generating…" : "Generate frame"}
            </button>
            {!description.trim() && <span className="muted">A description is required.</span>}
          </div>

          {sourceBlocked && <p className="warn">Choose a source with a ready selected image or clear the source before generating.</p>}
          {excessConcepts > 0 && <p className="warn">Remove {excessConcepts} concept{excessConcepts === 1 ? "" : "s"} to generate with these source settings.</p>}
          {excessCharacters > 0 && <p className="warn">Remove {excessCharacters} character concept{excessCharacters === 1 ? "" : "s"} before generating.</p>}

          {frame.generations.length > 0 && (
            <>
              <h2 style={{ marginTop: 24 }}>History</h2>
              <div className="history" role="region" aria-label="Generation history">
                {frame.generations.map((g) => (
                  <div key={g.id}>
                    <button
                      type="button"
                      className={`history-item${g.id === frame.selectedGenerationId ? " history-selected" : ""}`}
                      disabled={controlsDisabled || g.status !== "succeeded"}
                      aria-label={`Generation ${g.id}, ${g.status}`}
                      aria-pressed={g.id === frame.selectedGenerationId}
                      title={g.status === "succeeded" ? "Use this generation" : (g.errorCode ?? g.status)}
                      onClick={() => void onSelect(g.id)}
                    >
                      {g.imageUrl ? (
                        <img className="history-thumb" src={g.imageUrl} alt="Previous generation" />
                      ) : (
                        <div className="history-failed">{g.status === "succeeded" ? "Image unavailable" : (g.errorCode ?? g.status)}</div>
                      )}
                    </button>
                    <ContinuityNote continuity={g.continuity} frame={frame} frames={edits.sources} />
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
            <span className={characterCount > MAX_CHARACTER_CONCEPTS ? "budget-full" : ""}>
              Characters {characterCount} / {MAX_CHARACTER_CONCEPTS}
            </span>
            {" · "}
            <span className={attached.length > limit ? "budget-full" : ""}>
              Concepts {attached.length} / {limit}
            </span>
            {" · "}Continuity slots {sourceId ? CONTINUITY_REFERENCE_SLOTS : 0} / {CONTINUITY_REFERENCE_SLOTS}
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
