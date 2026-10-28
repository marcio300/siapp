export type PartnerClaimReason =
  | "malformed"
  | "unsupported_alg"
  | "unknown_community"
  | "community_inactive"
  | "bad_signature"
  | "expired"
  | "missing_claims"
  | "already_used"
  | "already_claimed"
  | "promo_failed";

export class PartnerError extends Error {
  constructor(
    public readonly reason: PartnerClaimReason,
    message: string,
  ) {
    super(message);
    this.name = "PartnerError";
  }
}
