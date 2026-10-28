import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { isReferralCodeActive } from "@/domain/referrals/status";
import { prisma as defaultPrisma } from "@/lib/db";

/**
 * Onboarding (spec §10, §15): name, date of birth with an explicit 24+
 * attestation, home city, optional referral code and partner claim token.
 * Completing it stamps `Member.onboardedAt`, which gates the member app.
 */

export const MIN_AGE = 24;

export class OnboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingError";
  }
}

/** Whole years between `dob` and `at` (UTC calendar). */
export function ageAt(dob: Date, at: Date): number {
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

export const OnboardingSchema = z.object({
  name: z.string().trim().min(2, "Tell us your name").max(80),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter your date of birth")
    .transform((s) => new Date(`${s}T00:00:00Z`))
    .refine((d) => !Number.isNaN(d.getTime()), "Enter a real date"),
  ageAttested: z.literal(true, { errorMap: () => ({ message: "You need to confirm you're 24 or older" }) }),
  cityId: z.string().min(1, "Pick your city"),
  referralCode: z
    .string()
    .trim()
    .toUpperCase()
    .max(16)
    .optional()
    .transform((v) => (v ? v : undefined)),
  partnerClaimToken: z
    .string()
    .trim()
    .max(4096)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export type OnboardingInput = z.input<typeof OnboardingSchema>;

/** Loose JWT shape check at onboarding; the claim itself (signature, promo) is src/domain/partners. */
export function looksLikeClaimToken(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export interface OnboardingResult {
  referral: "none" | "recorded" | "unknown_code" | "inactive_code" | "self" | "already_referred";
  partnerClaim: "none" | "stored" | "invalid";
}

export async function completeOnboarding(
  memberId: string,
  raw: OnboardingInput,
  opts: { db?: PrismaClient; now?: Date } = {},
): Promise<OnboardingResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const parsed = OnboardingSchema.safeParse(raw);
  if (!parsed.success) throw new OnboardingError(parsed.error.issues[0]?.message ?? "Invalid input");
  const input = parsed.data;

  if (input.dateOfBirth > now) throw new OnboardingError("Enter a real date of birth");
  if (ageAt(input.dateOfBirth, now) < MIN_AGE) {
    throw new OnboardingError(`Sorry, it's a ${MIN_AGE}+ party.`);
  }

  const city = await db.city.findUnique({ where: { id: input.cityId } });
  if (!city || !city.isActive) throw new OnboardingError("Pick an active city");

  const member = await db.member.findUniqueOrThrow({ where: { id: memberId } });
  const result: OnboardingResult = { referral: "none", partnerClaim: "none" };

  // Referral: recorded PENDING now when the referrer's code is active (paid, non-tourist — spec §9);
  // vesting and rejection are the daily job's work (src/domain/referrals).
  if (input.referralCode) {
    if (input.referralCode === member.referralCode) {
      result.referral = "self";
    } else {
      const referrer = await db.member.findUnique({ where: { referralCode: input.referralCode } });
      if (!referrer) result.referral = "unknown_code";
      else if (!(await isReferralCodeActive(referrer.id, { db }))) result.referral = "inactive_code";
      else {
        const existing = await db.referral.findUnique({ where: { inviteeId: memberId } });
        if (existing) result.referral = "already_referred";
        else {
          await db.referral.create({ data: { referrerId: referrer.id, inviteeId: memberId, code: input.referralCode } });
          result.referral = "recorded";
        }
      }
    }
  }

  let partnerToken: string | undefined;
  if (input.partnerClaimToken) {
    if (looksLikeClaimToken(input.partnerClaimToken)) {
      partnerToken = input.partnerClaimToken;
      result.partnerClaim = "stored";
    } else {
      result.partnerClaim = "invalid";
    }
  }

  await db.member.update({
    where: { id: memberId },
    data: {
      name: input.name,
      dateOfBirth: input.dateOfBirth,
      ageAttestedAt: member.ageAttestedAt ?? now,
      cityId: city.id,
      onboardedAt: member.onboardedAt ?? now,
      ...(partnerToken ? { partnerClaimToken: partnerToken, partnerClaimTokenAt: now } : {}),
    },
  });
  return result;
}
