import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = { create };
  },
}));

import { validateApiKey } from "../src/services/gemini.js";

function sdkError(status: number, payload: object): Error & { status: number } {
  return Object.assign(new Error(JSON.stringify(payload)), { name: "ApiError", status });
}

const invalidKey = sdkError(400, { error: {
  code: 400, status: "INVALID_ARGUMENT", message: "API key not valid.",
  details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID",
    domain: "googleapis.com" }],
} });

beforeEach(() => {
  create.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("account API key validation", () => {
  it("recognizes the structured 400 API_KEY_INVALID response", async () => {
    create.mockRejectedValue(invalidKey);
    await expect(validateApiKey("dummy-key")).resolves.toBe(false);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[1]).toMatchObject({ timeout: 20_000, maxRetries: 0 });
  });

  it("does not call every 400 an invalid key", async () => {
    create.mockRejectedValue(sdkError(400, { error: {
      status: "INVALID_ARGUMENT", details: [{ reason: "BAD_REQUEST" }],
    } }));
    await expect(validateApiKey("dummy-key")).rejects.toMatchObject({
      status: 502, code: "upstream_error", message: expect.stringContaining("verification request"),
    });
  });

  it("reads the SDK's structured error and body fields without matching free text", async () => {
    const body = JSON.parse(invalidKey.message) as object;
    create.mockRejectedValueOnce(Object.assign(new Error("bad key"), { status: 400, error: body }));
    await expect(validateApiKey("dummy-key")).resolves.toBe(false);
    create.mockRejectedValueOnce(Object.assign(new Error("bad key"), { status: 400, body: invalidKey.message }));
    await expect(validateApiKey("dummy-key")).resolves.toBe(false);
    create.mockRejectedValueOnce(Object.assign(new Error("API_KEY_INVALID appears in prose"), { status: 400 }));
    await expect(validateApiKey("dummy-key")).rejects.toMatchObject({ status: 502, code: "upstream_error" });
  });

  it("never includes key material or raw upstream bodies in errors or logs", async () => {
    const key = "fixture-secret-sentinel";
    create.mockRejectedValue(sdkError(503, { error: { message: `rejected ${key}` } }));
    const error = await validateApiKey(key).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 502, code: "upstream_error" });
    expect(String(error)).not.toContain(key);
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ["[gemini] key validation could not complete status=503"],
    ]);
  });

  it("accepts a successful interaction even if it has no output text", async () => {
    create.mockResolvedValue({ status: "completed" });
    await expect(validateApiKey("dummy-key")).resolves.toBe(true);
  });

  it("does not save a response that failed without throwing", async () => {
    create.mockResolvedValue({ status: "failed" });
    await expect(validateApiKey("dummy-key")).rejects.toMatchObject({ status: 502, code: "upstream_error" });
  });

  it("bounds the whole call, aborts transport, and ignores a late success", async () => {
    vi.useFakeTimers();
    let finish: (result: object) => void = () => {};
    create.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const result = validateApiKey("dummy-key");
    const outcome = expect(result).rejects.toMatchObject({ status: 504, code: "timeout" });
    const signal = create.mock.calls[0]?.[1].fetchOptions.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    finish({ status: "completed" });
    await expect(result).rejects.toMatchObject({ status: 504, code: "timeout" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("clears the application deadline on both success and failure", async () => {
    vi.useFakeTimers();
    create.mockResolvedValueOnce({ status: "completed" });
    await expect(validateApiKey("dummy-key")).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    create.mockRejectedValueOnce(invalidKey);
    await expect(validateApiKey("dummy-key")).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes permission, throttling, timeout and outage", async () => {
    for (const [error, expectedStatus, expectedCode] of [
      [sdkError(403, { error: { status: "PERMISSION_DENIED" } }), 422, "api_key_access_denied"],
      [sdkError(429, { error: { status: "RESOURCE_EXHAUSTED" } }), 503, "upstream_error"],
      [Object.assign(new Error("request timed out"), { name: "APIConnectionTimeoutError" }), 504, "timeout"],
      [new DOMException("request timed out", "TimeoutError"), 504, "timeout"],
      [sdkError(503, { error: { status: "UNAVAILABLE" } }), 502, "upstream_error"],
    ] as const) {
      create.mockRejectedValueOnce(error);
      await expect(validateApiKey("dummy-key")).rejects.toMatchObject({
        status: expectedStatus, code: expectedCode,
      });
    }
  });
});
