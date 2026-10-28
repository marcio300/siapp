import type { Member } from "@prisma/client";

/**
 * What a member still needs before they can redeem (spec §7 eligibility 1):
 * verified email, completed onboarding (24+ attested, city), selfie on file.
 */
export interface VerificationStatus {
  emailVerified: boolean;
  onboarded: boolean;
  selfie: boolean;
  banned: boolean;
  /** All of the above (and not banned) — the gate for the first redemption. */
  canRedeem: boolean;
  /** First thing to fix, as a member-facing path. */
  nextStep: "/app/onboarding" | "/app/profile" | null;
}

export function verificationStatus(
  member: Pick<Member, "emailVerified" | "onboardedAt" | "selfieUploadedAt" | "bannedAt">,
): VerificationStatus {
  const emailVerified = !!member.emailVerified;
  const onboarded = !!member.onboardedAt;
  const selfie = !!member.selfieUploadedAt;
  const banned = !!member.bannedAt;
  const canRedeem = emailVerified && onboarded && selfie && !banned;
  return {
    emailVerified,
    onboarded,
    selfie,
    banned,
    canRedeem,
    nextStep: !onboarded ? "/app/onboarding" : !selfie ? "/app/profile" : null,
  };
}
