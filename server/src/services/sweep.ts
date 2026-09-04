import { STALE_GENERATION_AGE_MS, SWEEP_INTERVAL_MS } from "@storyboards/shared";
import { deleteExpiredSessions } from "../db/sessions.js";
import { sweepStale } from "../db/generations.js";

/**
 * Stale generation sweep (TECH_SPEC.md section 7.1).
 *
 * Railway restarts the container on every deploy. Any in-flight generation is
 * lost, but its pending row survives -- leaving the UI spinning forever. The
 * spec calls this "not optional… the difference between a prototype that
 * recovers from a deploy and one that requires manual database surgery."
 *
 * The 5-minute threshold sits well beyond the ~90s worst case of a live
 * generation (a 90s total deadline plus 10s of backoff), so a running
 * generation is never swept.
 */
async function runSweep(): Promise<void> {
  try {
    const swept = await sweepStale(STALE_GENERATION_AGE_MS);
    // Silent when there is nothing to do, so this does not spam the log every
    // minute for the lifetime of the process.
    if (swept > 0) console.log(`[sweep] marked ${swept} abandoned generation(s)`);

    // Expired sessions ride along on the existing interval rather than getting
    // one of their own.
    const sessions = await deleteExpiredSessions();
    if (sessions > 0) console.log(`[sweep] deleted ${sessions} expired session(s)`);
  } catch (err) {
    console.error("[sweep] failed", err);
  }
}

/** Sweeps immediately, then on an interval. Returns a stop function. */
export function startSweeper(): () => void {
  void runSweep();
  const handle = setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
  return () => clearInterval(handle);
}
