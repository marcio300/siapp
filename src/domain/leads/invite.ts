import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { sendFounderInvitation } from "./notify";

export interface InviteOptions {
  db?: PrismaClient;
  now?: Date;
  /** Also re-send to leads already CONTACTED (a "resend" click). Default: NEW only. */
  resend?: boolean;
  /** Pause between sends in ms (Resend allows ~2 req/s). Tests pass 0. */
  paceMs?: number;
}

export interface InviteResult {
  sent: number;
  /** Rows skipped because their status wasn't eligible (converted, unsubscribed, or contacted without `resend`). */
  skipped: number;
  failed: { id: string; email: string; error: string }[];
}

/** Hard cap per call — one server action, well inside a Vercel function's time budget. */
export const INVITE_BATCH_MAX = 50;

/**
 * Email the launch invitation to the given leads and mark them CONTACTED.
 * Each lead is sent + marked on its own, so a failure halfway leaves the
 * earlier ones correctly recorded and the failed one still NEW (retry by
 * clicking again). Never invites a converted or unsubscribed lead.
 */
export async function inviteLeads(ids: string[], staffId: string, opts: InviteOptions = {}): Promise<InviteResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const paceMs = opts.paceMs ?? 400;
  const statuses: ("NEW" | "CONTACTED")[] = opts.resend ? ["NEW", "CONTACTED"] : ["NEW"];
  const unique = [...new Set(ids)].slice(0, INVITE_BATCH_MAX);
  const leads = await db.founderLead.findMany({ where: { id: { in: unique }, status: { in: statuses } }, orderBy: { number: "asc" } });
  const result: InviteResult = { sent: 0, skipped: unique.length - leads.length, failed: [] };

  for (const [i, lead] of leads.entries()) {
    if (i > 0 && paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    try {
      await sendFounderInvitation(lead);
    } catch (e) {
      result.failed.push({ id: lead.id, email: lead.email, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    await db.founderLead.update({
      where: { id: lead.id },
      data: {
        status: "CONTACTED",
        invitedAt: now,
        invitationCount: { increment: 1 },
        ...(lead.contactedAt ? {} : { contactedAt: now, contactedById: staffId }),
      },
    });
    result.sent++;
  }
  return result;
}
