import type { FounderLead } from "@prisma/client";
import { sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email/template";
import { translatorFor } from "@/i18n/messages";

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function unsubscribeUrl(lead: Pick<FounderLead, "unsubscribeToken">): string {
  return `${appUrl()}/founders/unsubscribe?t=${encodeURIComponent(lead.unsubscribeToken)}`;
}

type LeadForEmail = Pick<FounderLead, "name" | "number" | "email" | "unsubscribeToken"> & { locale?: string | null };

function firstName(lead: Pick<FounderLead, "name">): string | undefined {
  return lead.name?.trim().split(/\s+/)[0]?.toLowerCase() || undefined;
}

/** "you're on the list" — sent once, on the first signup (and again if they re-subscribe). In the lead's language. */
export function founderWelcomeEmail(lead: LeadForEmail) {
  const t = translatorFor(lead.locale, "founderEmails");
  const name = firstName(lead);
  const number = lead.number;
  return {
    subject: t("welcomeSubject", { number }),
    ...renderEmail({
      title: name ? t("welcomeTitleNamed", { name }) : t("welcomeTitle"),
      tagline: t("welcomeTagline"),
      preheader: t("welcomePreheader", { number }),
      paragraphs: [t("welcomeP1", { number }), t("welcomeP2"), t("welcomeP3")],
      footnote: t("welcomeFootnote", { url: unsubscribeUrl(lead) }),
      footer: t("footer", { url: `${appUrl()}/founders` }),
    }),
  };
}

export async function sendFounderWelcome(lead: FounderLead): Promise<void> {
  await sendEmail({ to: lead.email, ...founderWelcomeEmail(lead) });
}

/**
 * The launch invitation (sent from the backoffice), in the lead's language.
 * The sign-in link prefills the lead's email; signing in with it creates the
 * account and `linkLeadToMember` flips the lead to CONVERTED.
 */
export function founderInvitationEmail(lead: LeadForEmail) {
  const t = translatorFor(lead.locale, "founderEmails");
  const name = firstName(lead);
  const number = lead.number;
  const signInUrl = `${appUrl()}/sign-in?email=${encodeURIComponent(lead.email)}&next=${encodeURIComponent("/app")}`;
  return {
    subject: t("inviteSubject", { number }),
    ...renderEmail({
      title: name ? t("inviteTitleNamed", { name }) : t("inviteTitle"),
      tagline: t("inviteTagline"),
      preheader: t("invitePreheader"),
      paragraphs: [t("inviteP1", { number }), t("inviteP2", { email: lead.email }), t("inviteP3")],
      cta: { label: t("inviteCta"), url: signInUrl },
      footnote: t("inviteFootnote", { url: unsubscribeUrl(lead) }),
      footer: t("footer", { url: `${appUrl()}/founders` }),
    }),
  };
}

export async function sendFounderInvitation(lead: FounderLead): Promise<void> {
  await sendEmail({ to: lead.email, ...founderInvitationEmail(lead) });
}
