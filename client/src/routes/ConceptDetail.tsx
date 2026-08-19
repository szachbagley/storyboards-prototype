import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MAX_UPLOAD_BYTES, type ConceptType } from "@storyboards/shared";
import { ApiError, api } from "../api.js";
import { ConfirmButton } from "../components/ConfirmButton.js";
import { useApi } from "../hooks.js";

/**
 * The identity-only rule, enforcement point 2 of 3 (TECH_SPEC.md section 8.2).
 *
 * The other two are the description meta-prompt (phase 3) and the prompt
 * compiler (phase 5). A concept description that carries scene content does not
 * error -- it quietly fights every frame description it is compiled against.
 */
const PLACEHOLDER: Record<ConceptType, string> = {
  character:
    "Physical appearance, costume, materials, colours, wear, distinguishing marks.\n\nNot pose, action, expression, environment, lighting, camera angle or mood — the frame description supplies those.",
  setting:
    "Architecture, materials, scale, contents, era, state of repair.\n\nDescribe the place as it permanently is, not a shot of it — no weather, time of day or lighting.",
  prop:
    "Form, materials, colours, scale, markings, condition.\n\nThe object alone — not what holds it, and not its surroundings.",
};

const HELP: Record<ConceptType, string> = {
  character: "Describe who they are, not what they are doing.",
  setting: "Describe the place, not a shot of the place.",
  prop: "Describe the object, not where it sits.",
};

export function ConceptDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data: concept, loading, error, reload } = useApi(() => api.getConcept(id), [id]);

  const [description, setDescription] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (concept) setDescription(concept.description);
  }, [concept]);

  if (loading && !concept) return <p className="muted">Loading…</p>;
  if (!concept) return <div className="error-banner">{error ?? "Not found"}</div>;

  async function saveDescription(next: string) {
    if (!concept || next === concept.description) return;
    setBusy("save");
    setActionError(null);
    try {
      await api.updateConcept(concept.id, { description: next });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !concept) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setActionError(`Image must be ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB or smaller.`);
      return;
    }
    setBusy("upload");
    setActionError(null);
    try {
      await api.uploadConceptImage(concept.id, file);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  /**
   * TECH_SPEC.md section 12.2: writes straight into an empty field, but confirms
   * before replacing existing content. The endpoint returns text without
   * persisting, so the draft is held here and only committed on confirmation --
   * a hand-tuned description must never be lost to a misclick.
   */
  async function onDescribe() {
    if (!concept) return;
    setBusy("describe");
    setActionError(null);
    try {
      const { description: draft } = await api.describeConcept(concept.id);
      if (description.trim().length === 0) {
        setDescription(draft);
        await saveDescription(draft);
      } else {
        setPendingDraft(draft);
      }
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!concept) return;
    setBusy("delete");
    try {
      await api.deleteConcept(concept.id);
      navigate("/concepts", { replace: true });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <>
      <div className="spread" style={{ marginBottom: 18 }}>
        <div className="row">
          <Link to="/concepts" className="back" aria-label="Back to concepts">‹</Link>
          <h1>{concept.name}</h1>
          <span className="muted">{concept.type}</span>
        </div>
        <ConfirmButton
          label="Delete concept"
          confirmLabel="Delete permanently"
          busy={busy === "delete"}
          onConfirm={onDelete}
        />
      </div>

      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="detail">
        <div>
          {concept.imageUrl ? (
            <img className="concept-image" src={concept.imageUrl} alt={`${concept.name} reference`} />
          ) : (
            <div className="frame-placeholder">No reference image yet</div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <input ref={fileInput} type="file" accept="image/*" hidden onChange={onUpload} />
            <button className="btn" type="button" disabled={busy === "upload"} onClick={() => fileInput.current?.click()}>
              {busy === "upload" ? "Uploading…" : concept.imageUrl ? "Replace image" : "Upload image"}
            </button>
          </div>
          {!concept.imageUrl && (
            <p className="warn" style={{ marginTop: 8 }}>
              Without a reference image this concept contributes text only, which will not hold its identity across frames.
            </p>
          )}
        </div>

        <div>
          <div className="spread" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Description</h2>
            {saved && <span className="saved">Saved</span>}
          </div>
          <textarea
            value={description}
            placeholder={PLACEHOLDER[concept.type]}
            aria-label="Concept description"
            onChange={(e) => setDescription(e.target.value)}
            onBlur={(e) => void saveDescription(e.target.value)}
          />
          <p className="muted" style={{ marginTop: 6 }}>{HELP[concept.type]}</p>

          {pendingDraft === null ? (
            <button className="btn" type="button" disabled={busy === "describe" || !concept.imageUrl} onClick={onDescribe}>
              {busy === "describe" ? "Generating…" : "Generate description"}
            </button>
          ) : (
            <div className="error-banner" style={{ background: "#fffbeb", borderColor: "#fde68a", color: "#92400e" }}>
              <p style={{ marginTop: 0 }}>Replace the existing description with the generated one?</p>
              <p className="muted" style={{ color: "inherit" }}>{pendingDraft}</p>
              <div className="row">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => { setDescription(pendingDraft); void saveDescription(pendingDraft); setPendingDraft(null); }}
                >
                  Replace
                </button>
                <button className="btn" type="button" onClick={() => setPendingDraft(null)}>Keep mine</button>
              </div>
            </div>
          )}
          {!concept.imageUrl && <p className="muted" style={{ marginTop: 6 }}>Upload a reference image to generate a description.</p>}
        </div>
      </div>
    </>
  );
}
