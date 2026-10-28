"use server";

import { redirect } from "next/navigation";
import { requireMember } from "@/lib/authz";
import { RedemptionError, cancelRedemption, startRedemptionPayment } from "@/domain/redemption";

export async function cancelTicketAction(fd: FormData): Promise<void> {
  const member = await requireMember();
  const id = String(fd.get("redemptionId") ?? "");
  try {
    await cancelRedemption(id, member.id);
  } catch (e) {
    if (e instanceof RedemptionError) redirect(`/app/tickets/${id}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect(`/app/tickets/${id}?cancelled=1`);
}

export async function payTicketAction(fd: FormData): Promise<void> {
  const member = await requireMember();
  const id = String(fd.get("redemptionId") ?? "");
  let url = "";
  try {
    url = (await startRedemptionPayment(id, member.id)).url;
  } catch (e) {
    if (e instanceof RedemptionError) redirect(`/app/tickets/${id}?error=${encodeURIComponent(e.message)}`);
    console.error("payment start failed:", e);
    redirect(`/app/tickets/${id}?error=${encodeURIComponent("Payments aren't available right now. Try again in a few minutes.")}`);
  }
  redirect(url);
}
