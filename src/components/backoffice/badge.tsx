import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "ok" | "warn" | "red";

const TONE: Record<BadgeTone, string> = {
  neutral: "badge",
  ok: "badge badge-ok",
  warn: "badge badge-warn",
  red: "badge badge-red",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={TONE[tone]}>{children}</span>;
}

/** Status → tone conventions (ported from EventOS): active/ok green, pending amber, cancelled red. */
export function statusTone(status: string): BadgeTone {
  if (["ACTIVE", "PUBLISHED", "PAID", "VESTED", "APPROVED", "OK", "CHECKED_IN"].includes(status)) return "ok";
  if (["PAST_DUE", "PENDING", "PENDING_PAYMENT", "HELD", "DRAFT", "OPEN", "WAITING", "NOTIFIED"].includes(status)) return "warn";
  if (["CANCELLED", "EXPIRED", "DENIED", "REJECTED", "NO_SHOW", "INVALID"].includes(status)) return "red";
  return "neutral";
}
