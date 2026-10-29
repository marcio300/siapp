"use server";

import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/authz";
import { text } from "@/lib/forms";
import { SettlementError, markSettlementPaid, reopenSettlement, sendSettlementEmail, settleEvents } from "@/domain/settlement";

function back(fd: FormData) {
  const b = text(fd, "back") ?? "/admin/settlements";
  return b.startsWith("/admin/") ? b : "/admin/settlements";
}
function go(fd: FormData, params: Record<string, string>): never {
  const url = new URL(back(fd), "http://x");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  redirect(`${url.pathname}${url.search}`);
}

export async function markPaidAction(fd: FormData): Promise<void> {
  const staff = await requireStaff("ADMIN");
  const id = text(fd, "id") ?? "";
  try {
    await markSettlementPaid(id, { reference: text(fd, "reference") ?? "", staffId: staff.staffId });
  } catch (e) {
    if (e instanceof SettlementError) go(fd, { error: e.message });
    throw e;
  }
  go(fd, { paid: "1" });
}

export async function reopenAction(fd: FormData): Promise<void> {
  await requireStaff("ADMIN");
  const id = text(fd, "id") ?? "";
  try {
    await reopenSettlement(id);
  } catch (e) {
    if (e instanceof SettlementError) go(fd, { error: e.message });
    throw e;
  }
  go(fd, { reopened: "1" });
}

export async function resendStatementAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  const id = text(fd, "id") ?? "";
  let ok = false;
  try {
    ok = await sendSettlementEmail(id);
  } catch (e) {
    if (e instanceof SettlementError) go(fd, { error: e.message });
    console.error("settlement email failed:", e);
    go(fd, { error: "The email couldn't be sent right now." });
  }
  go(fd, ok ? { sent: "1" } : { error: "The producer has no contact email — add one on the producer page." });
}

export async function runSettlementsAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  const r = await settleEvents();
  go(fd, { ran: `${r.settled} settled, ${r.emailed} emailed, ${r.nothingOwed} with nothing owed` });
}
