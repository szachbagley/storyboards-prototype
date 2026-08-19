import { useState } from "react";

/**
 * Inline two-step confirmation. The client never calls window.confirm.
 *
 * Beyond a native modal being a jarring interruption, it blocks the page's
 * event loop -- which would freeze the driven-browser verification this phase
 * relies on, on exactly the destructive flows that most need checking.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  busy = false,
  className = "btn btn-danger",
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button type="button" className={className} disabled={busy} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }

  return (
    <span className="row">
      <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
        {busy ? "Working…" : confirmLabel}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}
