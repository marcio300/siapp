"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireMember } from "@/lib/authz";
import { OnboardingError, completeOnboarding } from "@/domain/identity";

export async function completeOnboardingAction(formData: FormData): Promise<void> {
  const member = await requireMember();
  const dob = `${formData.get("dobYear")}-${String(formData.get("dobMonth")).padStart(2, "0")}-${String(formData.get("dobDay")).padStart(2, "0")}`;
  let result;
  try {
    result = await completeOnboarding(member.id, {
      name: String(formData.get("name") ?? ""),
      dateOfBirth: dob,
      cityId: String(formData.get("cityId") ?? ""),
      referralCode: String(formData.get("referralCode") ?? ""),
      partnerClaimToken: String(formData.get("partnerClaimToken") ?? ""),
    });
  } catch (e) {
    if (e instanceof OnboardingError) redirect(`/app/onboarding?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  const jar = await cookies();
  jar.delete("siapp_ref");
  const notes: string[] = [];
  if (result.referral === "unknown_code") notes.push("referral=unknown");
  if (result.referral === "self") notes.push("referral=self");
  if (result.referral === "inactive_code") notes.push("referral=inactive");
  if (result.partnerClaim === "invalid") notes.push("partner=invalid");
  if (result.partnerClaim === "stored") {
    const { PartnerError, claimStoredToken } = await import("@/domain/partners");
    try {
      const claimed = await claimStoredToken(member.id);
      if (claimed) notes.push(`partner=${encodeURIComponent(`${claimed.community.name}: ${claimed.applied}`)}`);
    } catch (e) {
      if (e instanceof PartnerError) notes.push(`partnerError=${encodeURIComponent(e.message)}`);
      else console.error("partner claim at onboarding failed:", e);
    }
  }
  redirect(`/app/profile?welcome=1${notes.length ? `&${notes.join("&")}` : ""}`);
}
