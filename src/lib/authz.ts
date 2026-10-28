import { redirect } from "next/navigation";
import type { StaffRole } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * Backoffice auth guard (ported from EventOS's requireStaff/requireStaffPage,
 * with SIAPP's three fixed roles instead of editable permission sets).
 * Roles are ordered: ADMIN ⊃ OPS ⊃ DOOR.
 */

export class AuthzError extends Error {
  constructor(message = "Not authorized") {
    super(message);
    this.name = "AuthzError";
  }
}

export interface StaffContext {
  staffId: string;
  memberId: string;
  email: string;
  role: StaffRole;
}

const ROLE_RANK: Record<StaffRole, number> = { DOOR: 1, OPS: 2, ADMIN: 3 };

export function hasRole(ctx: { role: StaffRole }, minimum: StaffRole): boolean {
  return ROLE_RANK[ctx.role] >= ROLE_RANK[minimum];
}

/**
 * TEST SEAM — tests only. Server actions run outside a Next request context
 * in Vitest, where Auth.js `auth()` cannot resolve a session. When
 * TEST_STAFF_EMAIL is set and NODE_ENV is not production, the staff context
 * is built straight from that StaffUser row. Inert in production.
 */
async function testSeamContext(): Promise<StaffContext | null> {
  const email = process.env.TEST_STAFF_EMAIL;
  if (!email || process.env.NODE_ENV === "production") return null;
  const staff = await prisma.staffUser.findUnique({ where: { email } });
  const member = await prisma.member.findUnique({ where: { email }, select: { id: true } });
  if (!staff?.isActive || !member) return null;
  return { staffId: staff.id, memberId: member.id, email: staff.email, role: staff.role };
}

async function sessionContext(): Promise<StaffContext | null> {
  const session = await auth();
  if (!session?.user?.staffId || !session.user.staffRole) return null;
  return {
    staffId: session.user.staffId,
    memberId: session.user.id,
    email: session.user.email ?? "",
    role: session.user.staffRole,
  };
}

/** For server components/pages: redirects when unauthenticated or under-privileged. */
export async function requireStaffPage(minimum: StaffRole = "DOOR"): Promise<StaffContext> {
  const ctx = (await testSeamContext()) ?? (await sessionContext());
  if (!ctx) redirect("/sign-in?next=/admin");
  if (!hasRole(ctx, minimum)) redirect("/admin");
  return ctx;
}

/** For server actions/route handlers: throws instead of redirecting. */
export async function requireStaff(minimum: StaffRole = "DOOR"): Promise<StaffContext> {
  const ctx = (await testSeamContext()) ?? (await sessionContext());
  if (!ctx) throw new AuthzError("Not signed in as staff");
  if (!hasRole(ctx, minimum)) throw new AuthzError();
  return ctx;
}

/** For member-facing pages: the signed-in member or a redirect to sign-in. */
export async function requireMemberPage(next = "/app"): Promise<{ id: string; email: string }> {
  const session = await auth();
  if (!session?.user?.id) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return { id: session.user.id, email: session.user.email ?? "" };
}
