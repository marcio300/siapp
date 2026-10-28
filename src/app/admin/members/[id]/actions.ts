"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/authz";
import { adjustKeys, KeysError } from "@/domain/keys";

const AdjustSchema = z.object({
  memberId: z.string().min(1),
  pool: z.enum(["PLAN", "PURCHASED"]),
  amount: z.coerce.number().int().refine((n) => n !== 0, "Amount must not be zero"),
  reason: z.string().trim().min(3, "A reason is required (at least 3 characters)").max(500),
});

/** ADMIN only: write an ADMIN_ADJUSTMENT row with a mandatory reason. */
export async function adjustKeysAction(formData: FormData): Promise<void> {
  const staff = await requireStaff("ADMIN");
  const parsed = AdjustSchema.safeParse({
    memberId: formData.get("memberId"),
    pool: formData.get("pool"),
    amount: formData.get("amount"),
    reason: formData.get("reason"),
  });
  const memberId = String(formData.get("memberId") ?? "");
  if (!parsed.success) {
    redirect(`/admin/members/${memberId}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid input")}`);
  }
  try {
    await adjustKeys(parsed.data.memberId, parsed.data.pool, parsed.data.amount, {
      reason: parsed.data.reason,
      staffId: staff.staffId,
    });
  } catch (e) {
    if (e instanceof KeysError) redirect(`/admin/members/${memberId}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect(`/admin/members/${memberId}?adjusted=${parsed.data.amount}`);
}
