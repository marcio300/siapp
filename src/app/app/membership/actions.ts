"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireMember } from "@/lib/authz";
import {
  BillingError,
  changeSubscriptionPlan,
  createPortalSession,
  setCancelAtPeriodEnd,
  startSubscriptionCheckout,
  startTouristPassCheckout,
} from "@/domain/billing";

const PriceSchema = z.object({ planPriceId: z.string().min(1) });

/** Partner (ELL) claim token typed on the membership screen, or the one stored at onboarding. */
export async function claimPartnerAction(formData: FormData): Promise<void> {
  const member = await requireMember();
  const { PartnerError, claimPartnerToken, claimStoredToken } = await import("@/domain/partners");
  const typed = String(formData.get("token") ?? "").trim();
  try {
    const res = typed ? await claimPartnerToken(member.id, typed) : await claimStoredToken(member.id);
    if (!res) redirect("/app/membership?error=Paste%20your%20partner%20token%20first");
    redirect(`/app/membership?claimed=${encodeURIComponent(`${res.community.name}: ${res.applied}`)}`);
  } catch (e) {
    if (e instanceof PartnerError) redirect(`/app/membership?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
}

/** Billing rule violations are shown to the member; anything else (Stripe down, no key) is logged and shown generically. */
function fail(e: unknown, back = "/app/membership"): never {
  if (e instanceof BillingError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
  console.error("billing action failed:", e);
  redirect(`${back}?error=${encodeURIComponent("Payments aren't available right now. Please try again in a few minutes.")}`);
}

/** Start a Stripe Checkout for a plan (new subscribers) or switch plans (existing ones). */
export async function choosePlanAction(formData: FormData): Promise<void> {
  const member = await requireMember();
  const parsed = PriceSchema.safeParse({ planPriceId: formData.get("planPriceId") });
  if (!parsed.success) redirect("/app/membership?error=Pick%20a%20plan");
  const mode = formData.get("mode") === "change" ? "change" : "subscribe";
  // EU consumer law: the auto-renewal disclosure must be acknowledged before the order (also enforced client-side).
  if (formData.get("acceptTerms") !== "on") redirect("/app/membership?error=" + encodeURIComponent("Tick the box to confirm you understand the plan renews automatically."));
  let url: string | null = null;
  try {
    if (mode === "change") {
      await changeSubscriptionPlan(member.id, parsed.data.planPriceId);
    } else {
      url = (await startSubscriptionCheckout(member.id, parsed.data.planPriceId)).url;
    }
  } catch (e) {
    fail(e);
  }
  redirect(url ?? "/app/membership?changed=1");
}

export async function cancelRenewalAction(): Promise<void> {
  const member = await requireMember();
  try {
    await setCancelAtPeriodEnd(member.id, true);
  } catch (e) {
    fail(e);
  }
  redirect("/app/membership?cancelled=1");
}

export async function resumeRenewalAction(): Promise<void> {
  const member = await requireMember();
  try {
    await setCancelAtPeriodEnd(member.id, false);
  } catch (e) {
    fail(e);
  }
  redirect("/app/membership?resumed=1");
}

export async function touristPassAction(): Promise<void> {
  const member = await requireMember();
  let url = "";
  try {
    url = (await startTouristPassCheckout(member.id)).url;
  } catch (e) {
    fail(e);
  }
  redirect(url);
}

export async function portalAction(): Promise<void> {
  const member = await requireMember();
  let url = "";
  try {
    url = await createPortalSession(member.id);
  } catch (e) {
    fail(e);
  }
  redirect(url);
}
