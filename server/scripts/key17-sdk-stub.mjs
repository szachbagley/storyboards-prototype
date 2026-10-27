const fixture = globalThis.__key17Fixture;

export class GoogleGenAI {
  constructor({ apiKey }) {
    fixture.keysSeen.push(apiKey);
    this.interactions = { create: async (_request, options) => {
      fixture.calls.push({ timeout: options?.timeout, maxRetries: options?.maxRetries });
      if (fixture.nextError) {
        const error = fixture.nextError;
        fixture.nextError = null;
        throw error;
      }
      const status = fixture.nextStatus ?? "completed";
      fixture.nextStatus = null;
      return fixture.emptyResponse ? { status } : { status, output_text: "ok" };
    } };
  }
}
