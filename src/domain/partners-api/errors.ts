/**
 * Partner API errors (contract docs/SIAPP_API.md §1 "Errors"): HTTP status + a
 * snake_case code + a human message, optionally per-field details. Routes turn
 * these into `{ error: { code, message, details } }`.
 */
export type PartnerErrorCode =
  | "unauthorized"
  | "producer_revoked"
  | "forbidden"
  | "not_found"
  | "stale_version"
  | "conflict"
  | "producer_bound"
  | "validation_failed"
  | "idempotency_mismatch"
  | "rate_limited"
  | "no_settlement"
  | "no_offers"
  | "qr_mismatch"
  | "bad_signature"
  | "expired"
  | "internal";

export interface ValidationDetail {
  /** Offer ref when the problem is about one offer. */
  ref?: string;
  field: string;
  code: string;
  message: string;
}

export class PartnerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: PartnerErrorCode,
    message: string,
    public readonly details?: ValidationDetail[],
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "PartnerApiError";
  }

  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const validationFailed = (details: ValidationDetail[]) =>
  new PartnerApiError(422, "validation_failed", details[0] ? `${details[0].field}: ${details[0].message}` : "Validation failed", details);
