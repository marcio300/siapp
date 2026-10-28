"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireMember } from "@/lib/authz";
import { BillingError, startKeyPackCheckout } from "@/domain/billing";

export async function buyPackAction(formData: FormData): Promise<void> {
  const member = await requireMember();
  const parsed = z.object({ keyPackId: z.string().min(1) }).safeParse({ keyPackId: formData.get("keyPackId") });
  if (!parsed.success) redirect("/app/wallet?error=Pick%20a%20pack");
  let url = "";
  try {
    url = (await startKeyPackCheckout(member.id, parsed.data.keyPackId)).url;
  } catch (e) {
    if (e instanceof BillingError) redirect(`/app/wallet?error=${encodeURIComponent(e.message)}`);
    console.error("billing action failed:", e);
    redirect(`/app/wallet?error=${encodeURIComponent("Payments aren't available right now. Please try again in a few minutes.")}`);
  }
  redirect(url);
}
