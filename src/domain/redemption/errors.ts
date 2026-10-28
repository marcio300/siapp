/**
 * Typed refusal reasons (spec §7 eligibility, in evaluation order). The
 * member app maps each to plain-language copy; `detail` carries what the
 * copy needs (an opens-at time, a tier, a count).
 */
export type RefusalReason =
  | "BANNED"
  | "NOT_VERIFIED"
  | "EVENT_NOT_OPEN"
  | "OFFER_NOT_OPEN"
  | "OFFER_CLOSED"
  | "TIER_NOT_ALLOWED"
  | "PRIVATE_SALE"
  | "SOLD_OUT"
  | "MAX_PER_MEMBER"
  | "INSUFFICIENT_KEYS"
  | "OVERLAP"
  | "PLUS_ONE_NOT_ALLOWED"
  | "WAITLIST_ONLY";

export class RedemptionError extends Error {
  constructor(
    public readonly reason: RefusalReason | "NOT_FOUND" | "NOT_CANCELLABLE" | "BAD_STATE" | "TOO_LATE",
    message: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RedemptionError";
  }
}
