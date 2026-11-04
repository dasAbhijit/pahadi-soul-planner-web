/** An error staff can read as is. `code` lets callers and tests tell them apart. */
export class AppError extends Error {
  constructor(public code: string, message: string, public info: Record<string, number> = {}) {
    super(message);
    this.name = 'AppError';
  }
}
