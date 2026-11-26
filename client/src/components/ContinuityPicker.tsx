import type { FrameSummaryDto } from "@storyboards/shared";

const readiness = {
  none: "No image selected",
  pending: "Selected image is pending",
  failed: "Selected generation failed",
  invalid: "Selected image is unusable",
  ready: "Selected image ready",
} as const;

export function sourceReady(frame: FrameSummaryDto | undefined): boolean {
  return frame?.selectedImageState === "ready" && !!frame.selectedGenerationId;
}

interface Props {
  targetId: string;
  sourceId: string | null;
  frames: FrameSummaryDto[] | null;
  error: string | null;
  disabled: boolean;
  onChange: (id: string | null) => void;
  refresh: () => void;
}

export function ContinuityPicker({ targetId, sourceId, frames, error, disabled, onChange, refresh }: Props) {
  const targetIndex = frames?.findIndex(frame => frame.id === targetId) ?? -1;
  return (
    <fieldset className="continuity-picker" disabled={disabled}>
      <legend>Continuity source</legend>
      <p>Choose a frame to carry its look into this shot. Generation uses the image selected on that frame when the request starts.</p>
      <p>Your scene description overrides conflicting details in the source and concept references. Concepts establish subject identity. The source supplies visual details you leave unspecified.</p>
      <button type="button" className="btn btn-small" onClick={refresh}>Refresh sources</button>
      {error && <p role="alert">Source choices unavailable. {error}</p>}
      {!frames && !error && <p role="status">Loading source frames…</p>}
      <label className="source-choice">
        <input type="radio" name="continuity-source" checked={sourceId === null} onChange={() => onChange(null)} />
        None
      </label>
      {sourceId && !frames?.some(frame => frame.id === sourceId) && (
        <label className="source-choice">
          <input type="radio" name="continuity-source" checked disabled />
          <span>Current source {sourceId} · {frames ? "Unavailable" : "Readiness unverified"}</span>
        </label>
      )}
      {frames?.map((frame, index) => {
        if (frame.id === targetId) return null;
        const ready = sourceReady(frame);
        const state = !ready && frame.selectedImageState === "ready" ? "invalid" : frame.selectedImageState;
        const description = frame.description.trim().replace(/\s+/g, " ");
        const excerpt = description.length > 100 ? description.slice(0, 99) + "…" : description;
        return (
          <label className="source-choice" key={frame.id}>
            <input type="radio" name="continuity-source" checked={sourceId === frame.id}
              disabled={!ready || !!error} onChange={() => onChange(frame.id)} />
            <span className="source-thumbnail tile-image" aria-hidden="true">
              {frame.imageUrl ? <img src={frame.imageUrl} alt="" loading="lazy" /> : "—"}
            </span>
            <span>
              <strong>Frame {index + 1} · {index < targetIndex ? "Earlier" : "Later"}</strong>
              <span className="source-excerpt">{excerpt || "No scene description"}</span>
              <span className="muted">{readiness[state] ?? "Readiness unknown"}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
