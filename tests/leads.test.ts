import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { setEmailSinkForTests, type SendEmailInput } from "@/lib/email";
import { memberAdapter } from "@/lib/auth-adapter";
import { LeadError, leadStats, leadsCsv, linkLeadToMember, markLeadsContacted, registerFounderLead, reopenLead, unsubscribeLead, utmFromQuery } from "@/domain/leads";
import { prisma, resetDatabase } from "./db";

const sent: SendEmailInput[] = [];

describe("founder pre-registration (leads)", () => {
  beforeAll(async () => {
    await resetDatabase();
    await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    setEmailSinkForTests(async (m) => {
      sent.push(m);
    });
  });

  it("creates one lead per email with a founder number, first-touch attribution and a welcome email", async () => {
    const lisbon = await prisma.city.findFirstOrThrow();
    const r = await registerFounderLead({
      email: "  Ana@Example.com ",
      name: "Ana Silva",
      cityId: lisbon.id,
      consent: true,
      utm: utmFromQuery({ utm_source: "instagram", utm_medium: "paid", utm_campaign: "founders-nov", utm_content: ["story-a"] }),
      referrer: "https://l.instagram.com/",
      landingPath: "/founders",
    });
    expect(r.created).toBe(true);
    expect(r.lead).toMatchObject({ email: "ana@example.com", name: "Ana Silva", cityId: lisbon.id, status: "NEW", utmSource: "instagram", utmMedium: "paid", utmCampaign: "founders-nov", utmContent: "story-a", utmTerm: null, landingPath: "/founders" });
    expect(r.lead.number).toBeGreaterThan(0);
    expect(r.lead.welcomeEmailSentAt).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ana@example.com");
    expect(sent[0]!.subject).toBe(`you're founder #${r.lead.number}`);
    expect(sent[0]!.text).toContain(`/founders/unsubscribe?t=${r.lead.unsubscribeToken}`);
    expect(sent[0]!.html).not.toContain("you have a SIAPP account");

    // Repeat signup from a different ad: same row, same number, attribution untouched, no second email.
    const again = await registerFounderLead({ email: "ana@example.com", consent: true, utm: { source: "tiktok" } });
    expect(again.created).toBe(false);
    expect(again.lead.id).toBe(r.lead.id);
    expect(again.lead.number).toBe(r.lead.number);
    expect(again.lead.utmSource).toBe("instagram");
    expect(again.lead.name).toBe("Ana Silva");
    expect(sent).toHaveLength(1);
    expect(await prisma.founderLead.count()).toBe(1);

    const second = await registerFounderLead({ email: "bruno@example.com", consent: true });
    expect(second.lead.number).toBe(r.lead.number + 1);
  });

  it("refuses bad emails, disposable domains and missing consent — and writes nothing", async () => {
    const before = await prisma.founderLead.count();
    await expect(registerFounderLead({ email: "not-an-email", consent: true })).rejects.toMatchObject({ reason: "invalid_email" });
    await expect(registerFounderLead({ email: "x@mailinator.com", consent: true })).rejects.toMatchObject({ reason: "disposable" });
    await expect(registerFounderLead({ email: "c@example.com", consent: false })).rejects.toMatchObject({ reason: "consent_required" });
    await expect(registerFounderLead({ email: "c@example.com" })).rejects.toBeInstanceOf(LeadError);
    expect(await prisma.founderLead.count()).toBe(before);
    // An unknown or inactive city is simply dropped, never an error.
    const r = await registerFounderLead({ email: "c@example.com", cityId: "nope", consent: true });
    expect(r.lead.cityId).toBeNull();
  });

  it("unsubscribes by token, and a fresh signup re-subscribes with a new welcome", async () => {
    const r = await registerFounderLead({ email: "dora@example.com", consent: true });
    const n = sent.length;
    await expect(unsubscribeLead("bogus")).rejects.toMatchObject({ reason: "not_found" });
    const off = await unsubscribeLead(r.lead.unsubscribeToken);
    expect(off.status).toBe("UNSUBSCRIBED");
    expect(off.unsubscribedAt).not.toBeNull();
    expect((await unsubscribeLead(r.lead.unsubscribeToken)).status).toBe("UNSUBSCRIBED"); // idempotent
    const back = await registerFounderLead({ email: "dora@example.com", consent: true });
    expect(back.created).toBe(false);
    expect(back.lead.status).toBe("NEW");
    expect(back.lead.unsubscribedAt).toBeNull();
    expect(back.lead.number).toBe(r.lead.number);
    expect(sent).toHaveLength(n + 1);
  });

  it("staff mark leads contacted (NEW only) and can undo; stats and CSV follow", async () => {
    const staff = await prisma.staffUser.findFirstOrThrow();
    const ana = await prisma.founderLead.findUniqueOrThrow({ where: { email: "ana@example.com" } });
    const bruno = await prisma.founderLead.findUniqueOrThrow({ where: { email: "bruno@example.com" } });
    const dora = await prisma.founderLead.findUniqueOrThrow({ where: { email: "dora@example.com" } });
    await unsubscribeLead(dora.unsubscribeToken);
    expect(await markLeadsContacted([ana.id, bruno.id, dora.id], staff.id)).toBe(2); // dora is unsubscribed → untouched
    const row = await prisma.founderLead.findUniqueOrThrow({ where: { id: ana.id } });
    expect(row).toMatchObject({ status: "CONTACTED", contactedById: staff.id });
    expect(row.contactedAt).not.toBeNull();
    expect(await markLeadsContacted([ana.id], staff.id)).toBe(0); // already contacted
    expect(await reopenLead(bruno.id)).toBe(true);
    expect(await reopenLead(bruno.id)).toBe(false);
    expect((await prisma.founderLead.findUniqueOrThrow({ where: { id: bruno.id } })).status).toBe("NEW");

    const stats = await leadStats();
    expect(stats.total).toBe(4);
    expect(stats.byStatus).toMatchObject({ NEW: 2, CONTACTED: 1, CONVERTED: 0, UNSUBSCRIBED: 1 });
    expect(stats.last7Days).toBe(4);
    expect(stats.bySource).toEqual(expect.arrayContaining([{ source: "instagram", count: 1 }, { source: "(direct)", count: 3 }]));

    const rows = await prisma.founderLead.findMany({ include: { city: { select: { name: true } } }, orderBy: { number: "asc" } });
    const csv = leadsCsv(rows);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("number,email,name,city,status,signed_up_at,consent_at,utm_source,utm_medium,utm_campaign,utm_content,utm_term,referrer,contacted_at,converted_at,unsubscribed_at");
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain(`${ana.number},ana@example.com,Ana Silva,Lisbon,CONTACTED,`);
    expect(lines[1]).toContain(",instagram,paid,founders-nov,story-a,,https://l.instagram.com/,");
  });

  it("links the lead when an account is created with the same email (auth adapter), so the deal can be honoured", async () => {
    const adapter = memberAdapter(prisma);
    const user = await adapter.createUser!({ id: "ignored", email: "ana@example.com", emailVerified: new Date() });
    const lead = await prisma.founderLead.findUniqueOrThrow({ where: { email: "ana@example.com" } });
    expect(lead).toMatchObject({ status: "CONVERTED", memberId: user.id });
    expect(lead.convertedAt).not.toBeNull();
    // Idempotent and case-insensitive; an email with no lead is a no-op.
    expect(await linkLeadToMember("ANA@example.com", user.id)).toBe(false);
    expect(await linkLeadToMember("nobody@example.com", user.id)).toBe(false);
    const member = await prisma.member.findUniqueOrThrow({ where: { id: user.id }, include: { founderLead: true } });
    expect(member.founderLead?.number).toBe(lead.number);
    // A converted lead never goes back to "to contact".
    const staff = await prisma.staffUser.findFirstOrThrow();
    expect(await markLeadsContacted([lead.id], staff.id)).toBe(0);
  });

  it("utmFromQuery ignores unknown keys and returns undefined when nothing is set", () => {
    expect(utmFromQuery({ page: "1" })).toBeUndefined();
    expect(utmFromQuery({ utm_source: " meta ", utm_term: "" })).toEqual({ source: "meta", medium: undefined, campaign: undefined, content: undefined, term: undefined });
  });
});
