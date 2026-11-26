import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FrameDto } from "@storyboards/shared";
import { ApiError, api, getToken } from "./api.js";
import { useGenerationPolling } from "./hooks.js";
import { readOutstanding, requestKey, writeOutstanding, type OutstandingRequest } from "./generationRequests.js";

const uncertain = "Submission could not be confirmed. Check request to see whether it was accepted.";
const absent = "Request not accepted yet; no saved attempt found. Resubmitting uses the current saved inputs and source if no earlier attempt wins. The first accepted attempt determines the recorded inputs.";
const storageMessage = "Browser storage is unavailable. Reload cannot resolve an unknown submission in this tab.";
type Recovery = "idle" | "checking" | "unknown" | "absent" | "submitting";

// The editor mounts this hook keyed by account and frame. A captured session and
// mount sequence also fence delayed async continuations across sign-out/unmount.
export function useFrameGeneration(userId: string, frameId: string, frame: FrameDto | null, onTerminal: () => void) {
  const key = requestKey(userId, frameId);
  const [{ value: initial, storageAvailable }] = useState(() => readOutstanding(key));
  const outstanding = useRef(initial);
  const [generationId, setGenerationId] = useState(initial?.generationId ?? null);
  const [recovered, setRecovered] = useState(Boolean(initial?.generationId));
  const [round, setRound] = useState(0);
  const [mode, setMode] = useState<Recovery>(initial?.requestId && !initial.generationId ? "unknown" : "idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(storageAvailable ? null : storageMessage);
  const lock = useRef(false);
  const terminalIds = useRef(new Set<string>());
  const mounted = useRef<symbol | null>(null);
  const session = useRef(getToken());
  const terminal = useRef(onTerminal);
  terminal.current = onTerminal;
  const matchingFrame = frame?.id === frameId;
  const polling = useGenerationPolling(frameId, matchingFrame ? generationId : null, round);

  useLayoutEffect(() => {
    mounted.current = Symbol();
    return () => { mounted.current = null; lock.current = false; };
  }, [key]);
  const current = (sequence: symbol | null) =>
    sequence !== null && sequence === mounted.current && session.current === getToken();
  const record = (value: OutstandingRequest | null) => {
    outstanding.current = value;
    if (!writeOutstanding(key, value)) {
      setStorageWarning(storageMessage);
    }
  };
  const resume = (id: string, requestId: string | null, recoveredAttempt = true) => {
    setRecovered(recoveredAttempt);
    record({ requestId, generationId: id });
    setGenerationId(id);
    setMode("idle");
    setNotice(null);
  };

  async function lookup() {
    const pending = outstanding.current;
    const seq = mounted.current;
    if (!pending?.requestId || pending.generationId || lock.current || !current(seq)) return;
    lock.current = true;
    setMode("checking");
    setNotice(null);
    try {
      const result = await api.lookupGenerationRequest(frameId, pending.requestId);
      if (current(seq)) resume(result.generationId, pending.requestId);
    } catch (error) {
      if (!current(seq)) return;
      if (error instanceof ApiError && error.status === 404) {
        setMode("absent");
        setNotice(absent);
      } else {
        setMode("unknown");
        setNotice("Could not check this request. Check again to see whether it was accepted.");
      }
    } finally {
      if (current(seq)) lock.current = false;
    }
  }

  useEffect(() => {
    if (matchingFrame && initial?.requestId && !initial.generationId) void lookup();
    // Only the first matching frame triggers automatic lookup. All recovery uses GET.
  }, [matchingFrame, initial]);

  useLayoutEffect(() => {
    const id = polling.generation?.id;
    if (!id || polling.generation?.status === "pending" || terminalIds.current.has(id)) return;
    if (!current(mounted.current)) return;
    terminalIds.current.add(id);
    if (outstanding.current?.generationId === id) record(null);
    terminal.current();
  }, [polling.generation]);

  useLayoutEffect(() => {
    if (!current(mounted.current) || !matchingFrame || outstanding.current || lock.current) return;
    const pending = frame.generations.find(row => row.status === "pending" && !terminalIds.current.has(row.id));
    if (pending) resume(pending.id, null);
  }, [frame, matchingFrame]);

  async function submit(source: string | null) {
    const seq = mounted.current;
    const previous = outstanding.current;
    if (!current(seq) || !matchingFrame || lock.current || previous?.generationId ||
        (previous?.requestId && mode !== "absent")) return;
    lock.current = true;
    try {
      const requestId = previous?.requestId ?? crypto.randomUUID();
      record({ requestId, generationId: null });
      setGenerationId(null);
      setMode("submitting");
      setNotice(null);
      try {
        const result = await api.generateFrame(frameId, requestId, source);
        if (current(seq)) resume(result.generationId, requestId, Boolean(previous?.requestId));
      } catch (error) {
        if (!current(seq)) return;
        const recorded = error instanceof ApiError && (
          (error.code === "generation_in_progress" && error.status === 409) ||
          (error.code === "admission_uncertain" && error.status === 503));
        if (recorded && typeof error.details === "object" && error.details !== null && "generationId" in error.details &&
            typeof error.details.generationId === "string") {
          resume(error.details.generationId, error.code === "admission_uncertain" ? requestId : null);
        } else if (recorded && error.code === "generation_in_progress") {
          // An older server omits the pending ID. Read owned frame history once.
          const latest = await api.getFrame(frameId).catch(() => null);
          if (!current(seq)) return;
          const pending = latest?.id === frameId ? latest.generations.find(row => row.status === "pending") : null;
          if (pending) resume(pending.id, null);
          else {
            setMode("unknown");
            setNotice("Another generation was running. Check request before resubmitting.");
          }
        } else if (!(error instanceof ApiError) || (error.status >= 500 && error.code !== "reference_storage_unavailable")) {
          setMode("unknown");
          setNotice(uncertain);
        } else {
          // An older original POST can still win after an explicit resubmit fails validation.
          if (previous?.requestId) {
            setMode("unknown");
            setNotice(uncertain);
          } else {
            record(null);
            setMode("idle");
          }
          throw error;
        }
      }
    } finally {
      if (current(seq)) lock.current = false;
    }
  }

  const check = () => {
    if (generationId) setRound(n => n + 1);
    else void lookup();
  };
  return { ...polling, submit, check, recovered, notice, storageWarning, checking: mode === "checking",
    submitting: mode === "submitting", canResubmit: mode === "absent",
    canCheck: mode === "unknown" || mode === "absent" || polling.timedOut,
    running: Boolean(generationId && !polling.timedOut && (!polling.generation || polling.generation.status === "pending")) };
}
