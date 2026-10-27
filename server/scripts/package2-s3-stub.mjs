const state = globalThis.__package2S3;

export class GetObjectCommand {
  constructor(input) { this.input = input; this.kind = "get"; }
}
export class PutObjectCommand {
  constructor(input) { this.input = input; this.kind = "put"; }
}
export class DeleteObjectCommand {
  constructor(input) { this.input = input; this.kind = "delete"; }
}
export class S3Client {
  async send(command, options) {
    state.calls.push({ kind: command.kind, key: command.input.Key, signal: options?.abortSignal });
    return state.send(command, options);
  }
}
export async function getSignedUrl() { return "http://127.0.0.1/fixture"; }
