export class ButterbaseError extends Error {
  readonly code: string;
  readonly status: number;
  readonly remediation?: string;
  readonly details?: unknown;

  constructor(message: string, code: string, status: number, remediation?: string, details?: unknown) {
    super(message);
    this.name = 'ButterbaseError';
    this.code = code;
    this.status = status;
    this.remediation = remediation;
    this.details = details;
  }
}
