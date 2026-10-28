"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/authz";
import { ReviewError, banMember, reviewFlag, unbanMember } from "@/domain/fraud";

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

/** OPS+: approve or deny a flag (releases/denies a linked HELD redemption). */
export async function reviewFlagAction(formData: FormData): Promise<void> {
  const staff = await requireStaff("OPS");
  const parsed = z
    .object({ flagId: z.string().min(1), decision: z.enum(["APPROVED", "DENIED"]), note: z.string().max(500).optional(), back: z.string().optional() })
    .safeParse({ flagId: formData.get("flagId"), decision: formData.get("decision"), note: formData.get("note") ?? undefined, back: formData.get("back") ?? undefined });
  const path = parsed.success && parsed.data.back?.startsWith("/admin") ? parsed.data.back : "/admin/fraud";
  if (!parsed.success) back(path, { error: parsed.error.issues[0]?.message ?? "Invalid input" });
  try {
    await reviewFlag(parsed.data.flagId, parsed.data.decision, { staffId: staff.staffId, note: parsed.data.note });
  } catch (e) {
    if (e instanceof ReviewError) back(path, { error: e.message });
    throw e;
  }
  back(path, { reviewed: parsed.data.decision.toLowerCase() });
}

/** ADMIN: ban a member (closes open flags, denies held redemptions, kills sessions). */
export async function banMemberAction(formData: FormData): Promise<void> {
  const staff = await requireStaff("ADMIN");
  const parsed = z
    .object({ memberId: z.string().min(1), reason: z.string().trim().min(3, "A reason is required"), back: z.string().optional() })
    .safeParse({ memberId: formData.get("memberId"), reason: formData.get("reason"), back: formData.get("back") ?? undefined });
  const memberId = String(formData.get("memberId") ?? "");
  const path = parsed.success && parsed.data.back?.startsWith("/admin") ? parsed.data.back : `/admin/members/${memberId}`;
  if (!parsed.success) back(path, { error: parsed.error.issues[0]?.message ?? "Invalid input" });
  try {
    await banMember(parsed.data.memberId, { staffId: staff.staffId, reason: parsed.data.reason });
  } catch (e) {
    if (e instanceof ReviewError) back(path, { error: e.message });
    throw e;
  }
  back(path, { banned: "1" });
}

export async function unbanMemberAction(formData: FormData): Promise<void> {
  await requireStaff("ADMIN");
  const memberId = String(formData.get("memberId") ?? "");
  if (!memberId) redirect("/admin/members");
  await unbanMember(memberId);
  redirect(`/admin/members/${memberId}?unbanned=1`);
}
