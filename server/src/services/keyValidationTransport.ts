import {
  API_KEY_VALIDATION_MAX_RESPONSE_BYTES,
  API_KEY_VALIDATION_URL,
  DESCRIPTION_MODEL,
  DESCRIPTION_THINKING_LEVEL,
} from "@storyboards/shared";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";

/** Validation-only Interactions request; no retries or redirects. */
export function requestKeyValidation(apiKey: string, signal: AbortSignal): Promise<{ status?: unknown }> {
  if (signal.aborted) return Promise.reject(new DOMException("Gemini key verification aborted", "AbortError"));
  // Explicitly own/destroy both streams: tested SDK/fetch controller chains
  // could lose abort propagation after GC. No global transport/SDK patch.
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      response?.destroy();
      request.destroy();
      reject(error);
    };
    const abort = () => fail(new DOMException("Gemini key verification aborted", "AbortError"));
    // Node HTTPS does not follow redirects. The caller's key is sent only to
    // this fixed endpoint, never to a Location supplied in an upstream reply.
    const request = httpsRequest(API_KEY_VALIDATION_URL, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-goog-api-key": apiKey },
    }, (incoming) => {
      response = incoming;
      if (settled) { incoming.destroy(); return; }
      incoming.on("error", fail);
      incoming.on("aborted", () => fail(new Error("Gemini key verification response was interrupted")));
      incoming.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > API_KEY_VALIDATION_MAX_RESPONSE_BYTES) {
          fail(new Error("Gemini key verification response exceeded its byte limit"));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        if (settled) return;
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown; }
        catch { body = undefined; }
        const status = incoming.statusCode ?? 502;
        if (status < 200 || status >= 300) {
          // Preserve structured classification without copying upstream text
          // into Error.message. The caller never logs/returns this body.
          fail(Object.assign(new Error("Gemini key verification request failed"), { status, body }));
        } else if (typeof body !== "object" || body === null || Array.isArray(body)) {
          fail(new Error("Gemini key verification returned malformed JSON"));
        } else {
          settled = true;
          signal.removeEventListener("abort", abort);
          resolve({ status: (body as { status?: unknown }).status });
        }
      });
    });
    request.on("error", fail);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    request.end(JSON.stringify({
      model: DESCRIPTION_MODEL,
      input: [{ type: "text", text: "Reply with the single word: ok" }],
      generation_config: { thinking_level: DESCRIPTION_THINKING_LEVEL },
    }));
  });
}
