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

/**
 * The launch invitation (sent from the backoffice). The sign-in link
 * prefills the lead's email; signing in with it creates the account and
 * `linkLeadToMember` flips the lead to CONVERTED.
 */
export function founderInvitationEmail(lead: Pick<FounderLead, "name" | "number" | "email" | "unsubscribeToken">) {
  const first = lead.name?.trim().split(/\s+/)[0];
  const signInUrl = `${appUrl()}/sign-in?email=${encodeURIComponent(lead.email)}&next=${encodeURIComponent("/app")}`;
  return {
    subject: `founder #${lead.number}, the doors are open`,
    ...renderEmail({
      title: `sorry${first ? `, ${first.toLowerCase()}` : ""} — we kept you waiting.`,
      tagline: "the doors are open. you're first.",
      preheader: "Your invitation to create your SIAPP account — founder deal included.",
      paragraphs: [
        `You pre-registered as founder #${lead.number}. SIAPP is now open in Lisbon, and this is your invitation to create your account before everyone else.`,
        `Use the button below and sign in with ${lead.email} — the same address you registered with. That's what ties the founder deal to your account: our best membership terms, locked for as long as you stay a member.`,
        "Pick a plan, get your keys, spend them on free or discounted entry at partner parties. Show the QR at the door. You're in.",
      ],
      cta: { label: "Create my account", url: signInUrl },
      footnote: `Not interested after all? Unsubscribe here: ${unsubscribeUrl(lead)}`,
      footer: `You're receiving this because you pre-registered at ${appUrl()}/founders.`,
    }),
  };
}

export async function sendFounderInvitation(lead: FounderLead): Promise<void> {
  await sendEmail({ to: lead.email, ...founderInvitationEmail(lead) });
}
