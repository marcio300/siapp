import { Prisma, type FounderLead, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { isDisposableEmail } from "@/domain/fraud/disposable";
import { LeadError } from "./errors";
import { PreRegistrationSchema } from "./schema";
import { sendFounderWelcome } from "./notify";

export interface RegisterOptions {
  db?: PrismaClient;
  now?: Date;
  /** Send the welcome email (default true). Best-effort — a failed email never fails the signup. */
  sendWelcome?: boolean;
}

export interface RegisterResult {
  lead: FounderLead;
  /** false = this email was already on the list (we updated what they gave us and said nothing). */
  created: boolean;
}

/**
 * Pre-register a lead from the public /founders page. One row per email;
 * a repeat signup never creates a second row or a new founder number, but
 * it does refresh name/city and re-subscribes someone who had opted out.
 * UTM attribution is first touch: only written when the row is created.
 */
export async function registerFounderLead(raw: unknown, opts: RegisterOptions = {}): Promise<RegisterResult> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const parsed = PreRegistrationSchema.safeParse(raw);
  if (!parsed.success) {
    const consent = parsed.error.issues.some((i) => i.path[0] === "consent");
    throw new LeadError(consent ? "consent_required" : "invalid_email");
  }
  const input = parsed.data;
  if (!input.consent) throw new LeadError("consent_required");
  if (isDisposableEmail(input.email)) throw new LeadError("disposable");

  const city = input.cityId ? await db.city.findFirst({ where: { id: input.cityId, isActive: true }, select: { id: true } }) : null;

  const existing = await db.founderLead.findUnique({ where: { email: input.email } });
  let lead: FounderLead;
  let created = false;
  if (existing) {
    lead = await resubscribe(db, existing, input, city?.id ?? null, now);
  } else {
    try {
      lead = await db.founderLead.create({
        data: {
          email: input.email,
          name: input.name ?? null,
          cityId: city?.id ?? null,
          consentAt: now,
          utmSource: input.utm?.source ?? null,
          utmMedium: input.utm?.medium ?? null,
          utmCampaign: input.utm?.campaign ?? null,
          utmContent: input.utm?.content ?? null,
          utmTerm: input.utm?.term ?? null,
          referrer: input.referrer ?? null,
          landingPath: input.landingPath ?? null,
        },
      });
      created = true;
    } catch (e) {
      // Two submits of the same email at once: the loser becomes a repeat signup.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const row = await db.founderLead.findUniqueOrThrow({ where: { email: input.email } });
        lead = await resubscribe(db, row, input, city?.id ?? null, now);
      } else {
        throw e;
      }
    }
  }

  const wasUnsubscribed = existing?.status === "UNSUBSCRIBED";
  if ((created || wasUnsubscribed) && (opts.sendWelcome ?? true)) {
    try {
      await sendFounderWelcome(lead);
      lead = await db.founderLead.update({ where: { id: lead.id }, data: { welcomeEmailSentAt: now } });
    } catch (e) {
      console.error("founder welcome email failed", lead.id, e);
    }
  }
  return { lead, created };
}

async function resubscribe(db: PrismaClient, row: FounderLead, input: { name?: string }, cityId: string | null, now: Date): Promise<FounderLead> {
  return db.founderLead.update({
    where: { id: row.id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(cityId ? { cityId } : {}),
      consentAt: now,
      ...(row.status === "UNSUBSCRIBED" ? { status: "NEW", unsubscribedAt: null } : {}),
    },
  });
}

/** One-click unsubscribe from the welcome email. Unknown token → not_found. */
export async function unsubscribeLead(token: string, opts: { db?: PrismaClient; now?: Date } = {}): Promise<FounderLead> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const lead = await db.founderLead.findUnique({ where: { unsubscribeToken: token } });
  if (!lead) throw new LeadError("not_found");
  if (lead.status === "UNSUBSCRIBED") return lead;
  return db.founderLead.update({ where: { id: lead.id }, data: { status: "UNSUBSCRIBED", unsubscribedAt: now } });
}

/**
 * When an account is created with a lead's email, link the two so the founder
 * deal can be honoured and the lead stops showing as "to contact". Called
 * from the auth adapter's createUser (best-effort) — never throws into sign-in.
 */
export async function linkLeadToMember(email: string, memberId: string, opts: { db?: PrismaClient; now?: Date } = {}): Promise<boolean> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const res = await db.founderLead.updateMany({
    where: { email: email.trim().toLowerCase(), memberId: null },
    data: { memberId, status: "CONVERTED", convertedAt: now },
  });
  return res.count > 0;
}
