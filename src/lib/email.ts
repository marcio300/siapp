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
  /** Files to attach (content base64-encoded) — Resend's shape. */
  attachments?: { filename: string; content: string; contentType?: string }[];
}

type EmailSink = (input: SendEmailInput) => Promise<void>;
let testSink: EmailSink | null = null;

/** Tests capture outgoing mail here instead of the console. Inert in production. */
export function setEmailSinkForTests(sink: EmailSink | null): void {
  if (process.env.NODE_ENV === "production") return;
  testSink = sink;
}

export const DEFAULT_EMAIL_FROM = "SIAPP <hello@siapp.club>";

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? "resend";
  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM;
  if (testSink) return testSink(input);

  if (!apiKey) {
    // Logging a member's sign-in link to the console is not delivery.
    assertDevStandInAllowed("Console email (no EMAIL_API_KEY)", "set EMAIL_API_KEY and EMAIL_FROM");
    console.log(`[email:dev] to=${input.to} subject="${input.subject}"`);
    console.log(input.text ?? input.html);
    // EMAIL_OUTBOX_DIR: the Playwright e2e run reads magic links and notices from here.
    if (process.env.EMAIL_OUTBOX_DIR) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      mkdirSync(process.env.EMAIL_OUTBOX_DIR, { recursive: true });
      writeFileSync(join(process.env.EMAIL_OUTBOX_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`), JSON.stringify({ ...input, attachments: input.attachments?.map((a) => a.filename) }, null, 2));
    }
    if (input.attachments?.length) console.log(`[email:dev] attachments: ${input.attachments.map((a) => a.filename).join(", ")}`);
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
