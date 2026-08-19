/**
 * An error carrying the HTTP status and stable machine-readable code that the
 * client should see. Anything thrown that is not an AppError is treated as an
 * internal fault and reported to the client without detail.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}
