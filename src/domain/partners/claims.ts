import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { PartnerError } from "./errors";
import { peekClaimToken, verifyClaimToken } from "./jwt";
import { applyPromo, parsePromo } from "./promo";

export interface ClaimResult {
  claimId: string;
  community: { id: string; code: string; name: string };
  externalMemberId: string;
  applied: string;
}

/**
 * Spec §11 / invariant 9: verify the partner's RS256 token, insert the claim
 * (unique per community+external member and per token id, so a token can
 * never be used twice), apply the configured promo, and forget the raw token
 * the member typed at onboarding. Everything after verification runs in one
 * transaction: a promo that fails leaves no claim behind.
 */
export async function claimPartnerToken(memberId: string, token: string, opts: { db?: PrismaClient; now?: Date } = {}): Promise<ClaimResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const { payload } = peekClaimToken(token);
  if (typeof payload.source !== "string" || !payload.source) throw new PartnerError("missing_claims", "The token is missing its source");
  const community = await db.partnerCommunity.findUnique({ where: { code: payload.source.toUpperCase() } });
  if (!community) throw new PartnerError("unknown_community", `We don't have a partner called ${payload.source}`);
  if (!community.isActive) throw new PartnerError("community_inactive", `${community.name} claims are paused right now`);
  const claims = verifyClaimToken(token, community.publicKey, { now });
  const promo = parsePromo(community.promo);

  const mine = await db.partnerClaim.findFirst({ where: { communityId: community.id, memberId } });
  if (mine) throw new PartnerError("already_claimed", `You've already claimed your ${community.name} membership`);

  try {
    return await db.$transaction(async (tx) => {
      const claim = await tx.partnerClaim.create({
        data: { communityId: community.id, memberId, externalMemberId: claims.externalMemberId, tokenJti: claims.jti ?? null, claimedAt: now },
      });
      let applied: string;
      try {
        applied = await applyPromo(memberId, promo, { claimId: claim.id, communityCode: community.code }, { db: tx, now });
      } catch (e) {
        throw new PartnerError("promo_failed", e instanceof Error ? e.message : "The promo couldn't be applied");
      }
      await tx.member.update({ where: { id: memberId }, data: { partnerClaimToken: null, partnerClaimTokenAt: null } });
      return { claimId: claim.id, community: { id: community.id, code: community.code, name: community.name }, externalMemberId: claims.externalMemberId, applied };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new PartnerError("already_used", "This token was already used — each partner membership can be claimed once");
    }
    throw e;
  }
}

/** Retry the token a member typed at onboarding (kept on the row until it succeeds). */
export async function claimStoredToken(memberId: string, opts: { db?: PrismaClient; now?: Date } = {}): Promise<ClaimResult | null> {
  const db = opts.db ?? defaultPrisma;
  const m = await db.member.findUniqueOrThrow({ where: { id: memberId }, select: { partnerClaimToken: true } });
  if (!m.partnerClaimToken) return null;
  return claimPartnerToken(memberId, m.partnerClaimToken, opts);
}
