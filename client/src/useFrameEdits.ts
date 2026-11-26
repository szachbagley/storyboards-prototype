import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FrameDto } from "@storyboards/shared";
import { api, ApiError, getToken } from "./api.js";

interface DraftField<T> {
  value: T;
  sequence: number;
  dirty: boolean;
}

interface EditorData {
  frame: FrameDto | null;
  description: DraftField<string>;
  source: DraftField<string | null>;
}

function mergeField<T>(field: DraftField<T>, value: T, acknowledged?: number): DraftField<T> {
  if (field.dirty && field.sequence !== acknowledged) return field;
  return { value, sequence: field.sequence, dirty: false };
}

export function useFrameEdits(frameId: string, storyId: string) {
  const [data, setData] = useState<EditorData>({
    frame: null,
    description: { value: "", sequence: 0, dirty: false },
    source: { value: null, sequence: 0, dirty: false },
  });
  const latest = useRef(data);
  const [readError, setReadError] = useState<string | null>(null);
  const mounted = useRef(false);
  const [session] = useState(getToken);
  const current = useCallback(() => mounted.current && getToken() === session, [session]);
  const epoch = useRef(0);
  const readNumber = useRef(0);
  const reading = useRef(false);
  const readAfterWrites = useRef(false);
  const writes = useRef(new Set<Promise<void>>());
  const tail = useRef(Promise.resolve());

  const update = useCallback((next: EditorData) => {
    latest.current = next;
    setData(next);
  }, []);

  const merge = useCallback((frame: FrameDto, ack?: { description?: number; source?: number }) => {
    if (!current()) return;
    if (frame.id !== frameId || frame.storyId !== storyId) throw new Error("Frame does not belong to this story.");
    const before = latest.current;
    update({
      frame,
      description: mergeField(before.description, frame.description, ack?.description),
      source: mergeField(before.source, frame.continuitySourceFrameId ?? null, ack?.source),
    });
    setReadError(null);
  }, [current, frameId, storyId, update]);

  const reload = useCallback(() => {
    if (!current()) return;
    if (writes.current.size) {
      readAfterWrites.current = true;
      return;
    }
    const stamp = epoch.current;
    const number = ++readNumber.current;
    reading.current = true;
    const valid = () => current() && stamp === epoch.current && number === readNumber.current;
    void api.getFrame(frameId).then(frame => {
      if (valid()) merge(frame);
    }).catch((error: unknown) => {
      if (valid()) setReadError(error instanceof Error ? error.message : "Could not load the frame.");
    }).finally(() => {
      if (number === readNumber.current) reading.current = false;
    });
  }, [current, frameId, merge]);

  useLayoutEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [reload]);

  // A generation also depends on the success of writes outstanding at its click.
  // Ordinary subsequent edits can recover the queue after a rejected write.
  function enqueue(work: () => Promise<void>, requirePriorSuccess = false): Promise<void> {
    if (reading.current) readAfterWrites.current = true;
    epoch.current++;
    const prior = requirePriorSuccess
      ? Promise.allSettled(writes.current).then(outcomes => {
        const failure = outcomes.find(outcome => outcome.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })
      : tail.current;
    const result = prior.then(async () => {
      if (current()) await work();
    }).finally(() => {
      epoch.current++;
      writes.current.delete(result);
      if (writes.current.size === 0 && readAfterWrites.current) {
        readAfterWrites.current = false;
        reload();
      }
    });
    writes.current.add(result);
    tail.current = result.catch(() => {});
    return result;
  }

  function edit<K extends "description" | "source">(key: K, value: EditorData[K]["value"]) {
    const before = latest.current;
    update({ ...before, [key]: { value, sequence: before[key].sequence + 1, dirty: true } });
  }

  function preserveIntent(intent: EditorData) {
    const before = latest.current;
    // An earlier queued acknowledgement may have refreshed a clean field after
    // the click. Recover that click's value while preserving any later local edit.
    const description = before.description.sequence === intent.description.sequence ? intent.description : before.description;
    const source = before.source.sequence === intent.source.sequence ? intent.source : before.source;
    update({ ...before, description: { ...description, dirty: true }, source: { ...source, dirty: true } });
    reload();
  }

  async function save(intent: EditorData, generationBarrier: boolean) {
    const { description, source } = intent;
    const saved = latest.current.frame;
    if (!saved) throw new Error("Load this frame before saving.");
    const saveDescription = generationBarrier || description.dirty;
    const saveSource = generationBarrier || source.dirty;
    if (!saveDescription && !saveSource) return;
    if (!generationBarrier && (!saveDescription || description.value === saved.description) &&
        (!saveSource || source.value === (saved.continuitySourceFrameId ?? null))) {
      merge(saved, { description: saveDescription ? description.sequence : undefined,
        source: saveSource ? source.sequence : undefined });
      return;
    }
    const frame = await api.updateFrame(frameId, {
      ...(saveDescription && { description: description.value }),
      ...(saveSource && { continuitySourceFrameId: source.value }),
    }).catch((error: unknown) => {
      const prefix = "Could not save the " + (saveSource ? "scene and source" : "scene description") + ". ";
      if (error instanceof ApiError) {
        const issues = Array.isArray(error.details) ? error.details.flatMap(issue =>
          typeof issue?.path === "string" && typeof issue.message === "string" ? [issue.path + ": " + issue.message] : []) : [];
        throw new ApiError(error.status, error.code, prefix + (issues.join(". ") || error.message), error.details);
      }
      throw new Error(prefix + "Check your connection and try again.");
    });
    if (!current()) return;
    if (frame.id !== frameId || frame.storyId !== storyId) throw new Error("Received a different frame while saving.");
    if ((saveDescription && frame.description !== description.value) ||
        (saveSource && (frame.continuitySourceFrameId ?? null) !== source.value)) {
      throw new ApiError(409, "continuity_configuration_changed", "The saved scene or source changed. Review the current frame.");
    }
    merge(frame, {
      description: saveDescription ? description.sequence : undefined,
      source: saveSource ? source.sequence : undefined,
    });
  }

  return { ...data, readError, latest, reload, current, enqueue, merge, edit, save, preserveIntent };
}
