import { sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email/template";
import { formatDate, formatMoney } from "@/lib/format";

/** Emails of this phase (spec §16): confirmation, cancellation, waitlist spot. All best-effort. */
function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

async function safeSend(to: string, mail: { subject: string; html: string; text: string }) {
  try {
    await sendEmail({ to, ...mail });
  } catch (e) {
    console.error("email failed:", e);
  }
}

export async function emailRedemptionConfirmed(input: { to: string; eventTitle: string; startsAt: Date; timezone: string; offerName: string; keyCost: number; cashCents: number; plusOneName: string | null; redemptionId: string; cancelDeadlineAt: Date }) {
  const paragraphs = [
    `${input.eventTitle} · ${formatDate(input.startsAt, input.timezone)} · ${input.offerName}.`,
    `${input.keyCost} keys${input.cashCents > 0 ? ` + ${formatMoney(input.cashCents)}` : ""}${input.plusOneName ? ` · +1 ${input.plusOneName}` : ""}.`,
    `Your QR is in the app. Show it at the door with your face. You can cancel until ${formatDate(input.cancelDeadlineAt, input.timezone)} — after that it's final and a no-show costs the keys.`,
  ];
  await safeSend(input.to, {
    subject: `you're in — ${input.eventTitle}`,
    ...renderEmail({ title: "you're in.", tagline: "the door already knows your name.", paragraphs, cta: { label: "Open ticket", url: `${appUrl()}/app/tickets/${input.redemptionId}` } }),
  });
}

export async function emailRedemptionCancelled(input: { to: string; eventTitle: string; keysRefunded: number; cashCents: number }) {
  await safeSend(input.to, {
    subject: `cancelled — ${input.eventTitle}`,
    ...renderEmail({
      title: "cancelled.",
      tagline: "no hard feelings.",
      paragraphs: [`${input.keysRefunded} keys are back in your wallet${input.cashCents > 0 ? ` and ${formatMoney(input.cashCents)} is on its way back to your card` : ""}.`],
      cta: { label: "Find another night", url: `${appUrl()}/app` },
    }),
  });
}

export async function emailWaitlistSpot(input: { to: string; eventTitle: string; offerName: string; claimBy: Date; timezone: string; eventId: string }) {
  await safeSend(input.to, {
    subject: `a spot opened — ${input.eventTitle}`,
    ...renderEmail({
      title: "a spot opened.",
      tagline: "it's yours if you're quick.",
      paragraphs: [`${input.offerName} at ${input.eventTitle}. Redeem before ${formatDate(input.claimBy, input.timezone)} or it goes to the next in line.`],
      cta: { label: "Redeem now", url: `${appUrl()}/app/events/${input.eventId}` },
    }),
  });
}
