"use server";

import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/authz";
import { vestReferrals } from "@/domain/referrals";

export async function runVestingAction(): Promise<void> {
  await requireStaff("OPS");
  const r = await vestReferrals();
  redirect(`/admin/referrals?ran=${encodeURIComponent(`${r.vested} vested, ${r.rejected} rejected, ${r.pending} still pending`)}`);
}
