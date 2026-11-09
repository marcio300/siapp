import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";

export type SignInGate = { ok: true; via: "open" | "staff" | "member" | "invited" } | { ok: false; reason: "closed" };

/**
 * The launch switch (setting `public_signin_open`). While closed, a magic
 * link is sent only to: active staff, people who already have an account,
 * and founder leads we have INVITED (status CONTACTED or CONVERTED). Everyone
 * else is turned away before any email goes out and before any Member row
 * can be created — enforced in the Auth.js `signIn` callback, mirrored by
 * the sign-in pages for a friendly message.
 */
export async function signInAllowed(rawEmail: string, opts: { db?: PrismaClient } = {}): Promise<SignInGate> {
  const db = opts.db ?? defaultPrisma;
  const email = rawEmail.trim().toLowerCase();
  if ((await getSetting("public_signin_open", db)) === 1) return { ok: true, via: "open" };
  const [staff, member, lead] = await Promise.all([
    db.staffUser.findUnique({ where: { email }, select: { isActive: true } }),
    db.member.findUnique({ where: { email }, select: { deletedAt: true } }),
    db.founderLead.findUnique({ where: { email }, select: { status: true } }),
  ]);
  if (staff?.isActive) return { ok: true, via: "staff" };
  if (member && !member.deletedAt) return { ok: true, via: "member" };
  if (lead && (lead.status === "CONTACTED" || lead.status === "CONVERTED")) return { ok: true, via: "invited" };
  return { ok: false, reason: "closed" };
}

/** Is the email an active staff address? The staff sign-in page sends links to nobody else. */
export async function isActiveStaffEmail(rawEmail: string, opts: { db?: PrismaClient } = {}): Promise<boolean> {
  const db = opts.db ?? defaultPrisma;
  const staff = await db.staffUser.findUnique({ where: { email: rawEmail.trim().toLowerCase() }, select: { isActive: true } });
  return Boolean(staff?.isActive);
}
