import { sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email/template";

function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Spec §16 "referral vested" — one to each side, best-effort. */
export async function emailReferralVested(input: { to: string; keys: number; role: "referrer" | "invitee"; otherLabel: string }) {
  const paragraphs =
    input.role === "referrer"
      ? [`${input.otherLabel} paid, showed up, and stayed past the small print. ${input.keys} keys just landed in your wallet — the kind that never expire.`, "keep sending people. the cap resets every month."]
      : [`you came in through a friend's door. that's worth ${input.keys} keys, and they never expire.`, "your friend got the same. everyone wins, except the queue."];
  try {
    await sendEmail({
      to: input.to,
      subject: `${input.keys} keys — referral vested`,
      ...renderEmail({ title: "nice company.", tagline: "a referral just vested.", paragraphs, cta: { label: "Open wallet", url: `${appUrl()}/app/wallet` } }),
    });
  } catch (e) {
    console.error("email failed:", e);
  }
}
