import { useCallback, useEffect, useRef, useState } from "react";
import { CLIENT_POLL_CEILING_MS, POLL_INTERVAL_MS, type GenerationSummaryDto } from "@storyboards/shared";
import { ApiError, api } from "./api.js";

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Fetch-on-mount with a manual reload. No cache: at this scale refetching after
 * a mutation is simpler and more predictable than invalidating anything, and it
 * guarantees the view reflects what the server actually has.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[]): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Keeps the effect off a fetcher identity that changes on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcherRef
      .current()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally keyed on the caller's deps plus a reload nonce rather than
    // on `fetcher`, which is a fresh closure each render.
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

export interface PollingState {
  generation: GenerationSummaryDto | null;
  elapsedSeconds: number;
  timedOut: boolean;
}

/**
 * Poll a generation to completion (TECH_SPEC.md sections 7 and 12.3).
 *
 * The elapsed timer is required, not decorative: 10-40s is normal for image
 * generation and the spec notes that silence reads as failure.
 *
 * The ceiling is deliberately longer than the server's own 90s deadline, so the
 * server's classified error arrives first and the user sees an actionable
 * message instead of a generic client-side timeout.
 */
export function useGenerationPolling(frameId: string, generationId: string | null, round: number): PollingState {
  const identity = JSON.stringify([frameId, generationId, round]);
  const empty: PollingState = { generation: null, elapsedSeconds: 0, timedOut: false };
  const [result, setResult] = useState({ identity, ...empty });

  useEffect(() => {
    if (!generationId) return;
    const controller = new AbortController();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = setInterval(() => {
      setResult(previous => ({ ...previous, identity, elapsedSeconds: Math.floor((Date.now() - started) / 1000) }));
    }, 1000);
    const stop = () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(tick);
      clearTimeout(ceiling);
    };
    const ceiling = setTimeout(() => {
      stop();
      setResult(previous => ({ ...previous, identity, timedOut: true }));
    }, CLIENT_POLL_CEILING_MS);
    setResult({ identity, generation: null, elapsedSeconds: 0, timedOut: false });
    async function poll(id: string) {
      try {
        const next = await api.getGeneration(id, controller.signal);
        if (controller.signal.aborted) return;
        if (next.id === id) {
          setResult(previous => ({ ...previous, identity, generation: next }));
          if (next.status !== "pending") { stop(); return; }
        }
      } catch {
        // Transient read failures can be checked until the ceiling.
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(id), POLL_INTERVAL_MS);
    }
    void poll(generationId);
    return stop;
  }, [identity, generationId]);

  return result.identity === identity ? result : empty;
}
