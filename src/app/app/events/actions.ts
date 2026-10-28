"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireMember } from "@/lib/authz";
import { RedemptionError, joinWaitlist, leaveWaitlist, redeem, startRedemptionPayment } from "@/domain/redemption";

function fail(e: unknown, back: string): never {
  if (e instanceof RedemptionError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
  console.error("redemption action failed:", e);
  redirect(`${back}?error=${encodeURIComponent("Something went wrong. Try again in a moment.")}`);
}

export async function redeemAction(fd: FormData): Promise<void> {
  const member = await requireMember();
  const parsed = z
    .object({ eventId: z.string().min(1), offerId: z.string().min(1), plusOneName: z.string().trim().max(80).optional() })
    .safeParse({ eventId: fd.get("eventId"), offerId: fd.get("offerId"), plusOneName: fd.get("plusOneName") ?? undefined });
  if (!parsed.success) redirect("/app");
  const back = `/app/events/${parsed.data.eventId}`;
  let result;
  try {
    result = await redeem(member.id, parsed.data.offerId, { plusOneName: parsed.data.plusOneName || null });
  } catch (e) {
    fail(e, back);
  }
  if (result.status === "PENDING_PAYMENT") {
    let url = "";
    try {
      url = (await startRedemptionPayment(result.redemptionId, member.id)).url;
    } catch (e) {
      if (e instanceof RedemptionError) redirect(`/app/tickets/${result.redemptionId}?error=${encodeURIComponent(e.message)}`);
      console.error("payment start failed:", e);
      redirect(`/app/tickets/${result.redemptionId}?error=${encodeURIComponent("Payments aren't available right now. Your spot is held for a few minutes — try paying from the ticket.")}`);
    }
    redirect(url);
  }
  redirect(`/app/tickets/${result.redemptionId}?${result.status === "HELD" ? "held=1" : "new=1"}`);
}

export async function joinWaitlistAction(fd: FormData): Promise<void> {
  const member = await requireMember();
  const eventId = String(fd.get("eventId") ?? "");
  const offerId = String(fd.get("offerId") ?? "");
  try {
    await joinWaitlist(member.id, offerId);
  } catch (e) {
    fail(e, `/app/events/${eventId}`);
  }
  redirect(`/app/events/${eventId}?waitlist=joined`);
}

export async function leaveWaitlistAction(fd: FormData): Promise<void> {
  const member = await requireMember();
  const eventId = String(fd.get("eventId") ?? "");
  await leaveWaitlist(member.id, String(fd.get("offerId") ?? ""));
  redirect(`/app/events/${eventId}?waitlist=left`);
}
