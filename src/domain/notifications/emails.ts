import { sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email/template";
import { formatDate, formatDateOnly } from "@/lib/format";

/** Spec §16 emails that didn't belong to an earlier phase. Each throws on failure; `notifyOnce` handles that. */
function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
const keys = (n: number) => `${n} ${n === 1 ? "key" : "keys"}`;

export async function emailWelcome(input: { to: string; name: string | null; keys: number; tierName: string }) {
  const first = input.name?.trim().split(/\s+/)[0];
  await sendEmail({
    to: input.to,
    subject: "you're in. sort of.",
    ...renderEmail({
      title: first ? `${first.toLowerCase()}, welcome.` : "welcome.",
      tagline: "the door knows your name now. it still wants to see your face.",
      preheader: "Add a selfie, then spend your first keys.",
      paragraphs: [
        `You're on the ${input.tierName.toLowerCase()} tier with ${keys(input.keys)} in your wallet. Keys open doors: free entry, discounted tickets, guest lists — every event says what it costs.`,
        "Before your first night: add a selfie in your profile. The door scans your QR and compares it with your face. No selfie, no redemption.",
        "Then look at what's on this week. The good stuff opens early for paid tiers.",
      ],
      cta: { label: "Add your selfie", url: `${appUrl()}/app/profile` },
      footnote: "Every member has an invite code. Yours wakes up when you're on a paid plan.",
    }),
  });
}

export async function emailPlanKeysGranted(input: { to: string; keys: number; planName: string; expiresAt: Date; timezone: string; renewal: boolean }) {
  await sendEmail({
    to: input.to,
    subject: input.renewal ? `renewed — ${keys(input.keys)} landed` : `${keys(input.keys)} landed`,
    ...renderEmail({
      title: input.renewal ? "another month." : "keys in the wallet.",
      tagline: input.renewal ? `your ${input.planName.toLowerCase()} renewed.` : `${input.planName.toLowerCase()}, paid up.`,
      paragraphs: [
        `${keys(input.keys)} are in your wallet. They're plan keys: use them before ${formatDateOnly(input.expiresAt, input.timezone)} — plan keys expire with the period, purchased keys never do.`,
        "They're spent on the door, not at checkout: redeem, show up, get scanned.",
      ],
      cta: { label: "See what's on", url: `${appUrl()}/app` },
    }),
  });
}

export async function emailKeysExpiring(input: { to: string; keys: number; expiresAt: Date; timezone: string }) {
  await sendEmail({
    to: input.to,
    subject: `${keys(input.keys)} expire ${formatDateOnly(input.expiresAt, input.timezone)}`,
    ...renderEmail({
      title: "use them or lose them.",
      tagline: "three days left on your plan keys.",
      paragraphs: [`You still have ${keys(input.keys)} from this period. They expire on ${formatDate(input.expiresAt, input.timezone)}; whatever's left goes with them.`, "Purchased keys are safe — this is only about the plan ones."],
      cta: { label: "Find a night", url: `${appUrl()}/app` },
    }),
  });
}

export async function emailEventReminder(input: { to: string; eventTitle: string; venue: string | null; startsAt: Date; timezone: string; plusOneName: string | null; cancelDeadlineAt: Date; redemptionId: string; now: Date }) {
  const canStillCancel = input.cancelDeadlineAt > input.now;
  await sendEmail({
    to: input.to,
    subject: `tomorrow — ${input.eventTitle}`,
    ...renderEmail({
      title: "tomorrow night.",
      tagline: `${input.eventTitle}${input.venue ? ` at ${input.venue}` : ""}.`,
      preheader: `${formatDate(input.startsAt, input.timezone)} — bring your face.`,
      paragraphs: [
        `${formatDate(input.startsAt, input.timezone)}${input.plusOneName ? ` · you and ${input.plusOneName}` : ""}. Your QR is in the app; the door scans it and checks the selfie.`,
        canStillCancel
          ? `Can't make it? Cancel before ${formatDate(input.cancelDeadlineAt, input.timezone)} and the keys come straight back. After that it's final — a no-show costs the keys.`
          : "The cancellation window has closed: this one's final. If you don't show, the keys are gone — so show.",
      ],
      cta: { label: "Open ticket", url: `${appUrl()}/app/tickets/${input.redemptionId}` },
    }),
  });
}

export async function emailNoShow(input: { to: string; eventTitle: string; keysLost: number }) {
  await sendEmail({
    to: input.to,
    subject: `missed — ${input.eventTitle}`,
    ...renderEmail({
      title: "the door waited.",
      tagline: "you didn't come.",
      paragraphs: [`${input.eventTitle} ended without your QR being scanned, so the ${keys(input.keysLost)} you spent on it are gone. That's the deal inside 24 hours.`, "Next time, cancel before the cutoff and the keys come back."],
      cta: { label: "See what's on", url: `${appUrl()}/app` },
    }),
  });
}

export async function emailPaymentFailed(input: { to: string; planName: string }) {
  await sendEmail({
    to: input.to,
    subject: "your payment didn't go through",
    ...renderEmail({
      title: "the card said no.",
      tagline: `${input.planName.toLowerCase()} couldn't renew.`,
      paragraphs: ["Stripe will retry over the next few days. Update your card now and the renewal goes through on the next attempt — your keys for the new period land as soon as it does.", "If it keeps failing, the membership drops back to the free tier and plan keys stop."],
      cta: { label: "Update card", url: `${appUrl()}/app/membership` },
    }),
  });
}

export async function emailTouristExpiring(input: { to: string; endsAt: Date; timezone: string; keysLeft: number }) {
  await sendEmail({
    to: input.to,
    subject: `your week ends ${formatDate(input.endsAt, input.timezone)}`,
    ...renderEmail({
      title: "last night in town?",
      tagline: "your tourist pass ends tomorrow.",
      paragraphs: [`The pass runs until ${formatDate(input.endsAt, input.timezone)}${input.keysLeft > 0 ? ` and you still have ${keys(input.keysLeft)} — they go when the pass does` : ""}.`, "Staying longer? Pick a monthly plan and keep the door open."],
      cta: { label: input.keysLeft > 0 ? "Spend them tonight" : "Pick a plan", url: `${appUrl()}/app${input.keysLeft > 0 ? "" : "/membership"}` },
    }),
  });
}
