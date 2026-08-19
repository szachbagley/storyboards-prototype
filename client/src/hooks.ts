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
export function useGenerationPolling(generationId: string | null): PollingState {
  const [generation, setGeneration] = useState<GenerationSummaryDto | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    setGeneration(null);
    setElapsedSeconds(0);
    setTimedOut(false);
    if (!generationId) return;

    const startedAt = Date.now();
    let stopped = false;

    const tick = setInterval(() => {
      if (!stopped) setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    const poll = setInterval(() => {
      if (stopped) return;
      if (Date.now() - startedAt > CLIENT_POLL_CEILING_MS) {
        stopped = true;
        setTimedOut(true);
        return;
      }
      void api
        .getGeneration(generationId)
        .then((next) => {
          if (stopped) return;
          setGeneration(next);
          if (next.status !== "pending") stopped = true;
        })
        .catch(() => {
          /* transient; the next tick retries */
        });
    }, POLL_INTERVAL_MS);

    // Fetch once immediately so a already-finished generation resolves at once.
    void api.getGeneration(generationId).then((next) => {
      if (!stopped) {
        setGeneration(next);
        if (next.status !== "pending") stopped = true;
      }
    }).catch(() => {});

    return () => {
      stopped = true;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [generationId]);

  return { generation, elapsedSeconds, timedOut };
}
