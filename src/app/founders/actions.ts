"use server";

import { headers } from "next/headers";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { checkbox, text } from "@/lib/forms";
import { LeadError, registerFounderLead } from "@/domain/leads";
import { checkRateLimit } from "@/domain/partners-api/auth";

/** Signups per minute per IP before the form answers "slow down" (ads can burst, bots burst more). */
const SIGNUPS_PER_MINUTE_PER_IP = 8;

/**
 * The /founders form. Errors go back to the page as `?error=`; success lands
 * on /founders/thanks with the founder number. UTM fields ride along as
 * hidden inputs (the page reads them from the ad's query string).
 */
export async function preRegisterAction(formData: FormData): Promise<void> {
  const h = await headers();
  const locale = await getLocale();
  const utmQuery = text(formData, "utmQuery") ?? "";
  const back = (error: string) => redirect(`/founders?error=${error}${utmQuery ? `&${utmQuery}` : ""}`);

  // Honeypot: real people never see the "website" field; bots fill everything.
  if (text(formData, "website")) redirect(`/founders/thanks`);

  const ip = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "unknown").split(",")[0]!.trim();
  const rl = checkRateLimit(`founders:${ip}`, SIGNUPS_PER_MINUTE_PER_IP);
  if (!rl.ok) back("rate_limited");

  try {
    const { lead } = await registerFounderLead({
      email: text(formData, "email"),
      name: text(formData, "name"),
      cityId: text(formData, "cityId"),
      consent: checkbox(formData, "consent"),
      utm: {
        source: text(formData, "utm_source"),
        medium: text(formData, "utm_medium"),
        campaign: text(formData, "utm_campaign"),
        content: text(formData, "utm_content"),
        term: text(formData, "utm_term"),
      },
      referrer: h.get("referer") ?? undefined,
      landingPath: "/founders",
      locale: locale === "pt" ? "pt" : "en",
    });
    redirect(`/founders/thanks?n=${lead.number}`);
  } catch (e) {
    if (e instanceof LeadError) back(e.reason);
    throw e;
  }
}
