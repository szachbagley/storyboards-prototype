import {
  API_KEY_VALIDATION_MAX_RESPONSE_BYTES,
  API_KEY_VALIDATION_URL,
  DESCRIPTION_MODEL,
  DESCRIPTION_THINKING_LEVEL,
} from "@storyboards/shared";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";

export type KeyValidationStage =
  | "starting" | "socket_assigned" | "dns_complete" | "tcp_connected"
  | "tls_connected" | "request_finished" | "headers_received" | "body_complete";

/** Validation-only Interactions request; no retries or redirects. */
export function requestKeyValidation(
  apiKey: string,
  signal: AbortSignal,
  onProgress?: (stage: KeyValidationStage, elapsedMs: number) => void,
): Promise<{ status?: unknown }> {
  if (signal.aborted) return Promise.reject(new DOMException("Gemini key verification aborted", "AbortError"));
  // Explicitly own/destroy both streams: tested SDK/fetch controller chains
  // could lose abort propagation after GC. No global transport/SDK patch.
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let response: IncomingMessage | undefined;
    let socket: TLSSocket | undefined;
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const progress = (stage: KeyValidationStage) => {
      if (!settled) onProgress?.(stage, Date.now() - startedAt);
    };
    const detachSocket = () => {
      socket?.removeListener("lookup", onLookup);
      socket?.removeListener("connect", onConnect);
      socket?.removeListener("secureConnect", onSecureConnect);
    };
    const onLookup = () => progress("dns_complete");
    const onConnect = () => progress("tcp_connected");
    const onSecureConnect = () => progress("tls_connected");
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      detachSocket();
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
      progress("headers_received");
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
        progress("body_complete");
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
          detachSocket();
          resolve({ status: (body as { status?: unknown }).status });
        }
      });
    });
    request.on("socket", (assignedSocket) => {
      if (settled) return;
      socket = assignedSocket as TLSSocket;
      progress("socket_assigned");
      socket.on("lookup", onLookup);
      socket.on("connect", onConnect);
      socket.on("secureConnect", onSecureConnect);
    });
    request.on("finish", () => progress("request_finished"));
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
