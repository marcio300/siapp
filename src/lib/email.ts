/**
 * Provider-agnostic transactional email (ported from EventOS). Resend via
 * EMAIL_API_KEY; without a key, emails are printed to the console (dev only —
 * refused in production by assertDevStandInAllowed).
 */
import { assertDevStandInAllowed } from "@/lib/runtime-env";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export const DEFAULT_EMAIL_FROM = "SIAPP <hello@siapp.club>";

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? "resend";
  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM;

  if (!apiKey) {
    // Logging a member's sign-in link to the console is not delivery.
    assertDevStandInAllowed("Console email (no EMAIL_API_KEY)", "set EMAIL_API_KEY and EMAIL_FROM");
    console.log(`[email:dev] to=${input.to} subject="${input.subject}"`);
    console.log(input.text ?? input.html);
    return;
  }

  switch (provider) {
    case "resend": {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, ...input }),
      });
      if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
      return;
    }
    default:
      throw new Error(`Email provider not implemented: ${provider}`);
  }
}
