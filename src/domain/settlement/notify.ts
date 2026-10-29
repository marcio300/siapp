import { sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email/template";
import { formatDate, formatMoney } from "@/lib/format";

/** Spec §12/§16: the producer's settlement statement, CSV attached. Throws — the caller decides. */
export async function emailSettlementStatement(input: {
  to: string;
  producerName: string;
  eventTitle: string;
  startsAt: Date;
  timezone: string;
  scannedCount: number;
  amountCents: number;
  currency: string;
  status: "OPEN" | "PAID";
  reference: string | null;
  csv: string;
  filename: string;
}) {
  const paragraphs = [
    `${input.eventTitle} · ${formatDate(input.startsAt, input.timezone)}.`,
    `${input.scannedCount} discounted ${input.scannedCount === 1 ? "ticket" : "tickets"} scanned at the door. We collected the money; we owe you ${formatMoney(input.amountCents, input.currency)} (face value minus the agreed discount, per scanned ticket).`,
    input.status === "PAID" ? `Paid${input.reference ? ` — reference ${input.reference}` : ""}.` : "Payment follows to the payout details on file. The ticket-by-ticket statement is attached.",
  ];
  await sendEmail({
    to: input.to,
    subject: `settlement — ${input.eventTitle} · ${formatMoney(input.amountCents, input.currency)}`,
    ...renderEmail({ title: "the night, settled.", tagline: `for ${input.producerName}.`, paragraphs, footnote: "Free tickets and guest lists settle nothing; only scanned discounted tickets count." }),
    attachments: [{ filename: input.filename, content: Buffer.from(input.csv, "utf8").toString("base64"), contentType: "text/csv" }],
  });
}
