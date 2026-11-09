import type { FounderLead } from "@prisma/client";
import { sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email/template";

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function unsubscribeUrl(lead: Pick<FounderLead, "unsubscribeToken">): string {
  return `${appUrl()}/founders/unsubscribe?t=${encodeURIComponent(lead.unsubscribeToken)}`;
}

/** "you're on the list" — sent once, on the first signup (and again if they re-subscribe). */
export function founderWelcomeEmail(lead: Pick<FounderLead, "name" | "number" | "unsubscribeToken">) {
  const first = lead.name?.trim().split(/\s+/)[0];
  return {
    subject: `you're founder #${lead.number}`,
    ...renderEmail({
      title: `sorry, ${first ? `${first.toLowerCase()}, ` : ""}you're early.`,
      tagline: "that's exactly the point.",
      preheader: `Founder #${lead.number} — your founder deal is locked.`,
      paragraphs: [
        `You're founder #${lead.number} on the SIAPP list. The doors in Lisbon aren't open yet; when they are, you hear it first.`,
        "The founder deal is yours for keeps: the best membership terms we will ever offer, locked for as long as you stay a member. It never goes on sale again after launch.",
        "We'll email you once, with your invitation to create your account. Nothing else until then.",
      ],
      footnote: `Not you, or changed your mind? Unsubscribe here and we delete the lead: ${unsubscribeUrl(lead)}`,
      footer: `You're receiving this once because you pre-registered at ${appUrl()}/founders.`,
    }),
  };
}

export async function sendFounderWelcome(lead: FounderLead): Promise<void> {
  await sendEmail({ to: lead.email, ...founderWelcomeEmail(lead) });
}
