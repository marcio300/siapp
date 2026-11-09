export type LeadRefusal = "invalid_email" | "disposable" | "consent_required" | "rate_limited" | "not_found";

/** A pre-registration that was refused for a reason the page can explain. */
export class LeadError extends Error {
  constructor(
    public readonly reason: LeadRefusal,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "LeadError";
  }
}
