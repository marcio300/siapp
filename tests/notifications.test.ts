import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { setEmailSinkForTests, type SendEmailInput } from "@/lib/email";
import { handleStripeEvent } from "@/lib/stripe-webhook";
import { cronAuthorized, isCronJobName, runCronJob } from "@/lib/cron-jobs";
import { GET as cronGet } from "@/app/api/cron/[job]/route";
import { grantPlanKeys, reconcileBalances } from "@/domain/keys";
import { addMonths, applyPaidPeriod, registerBillingWebhooks, runMonthlyGrants } from "@/domain/billing";
import { completeOnboarding } from "@/domain/identity";
import { markNoShows } from "@/domain/redemption";
import { notifyOnce, sendEventReminders, sendKeysExpiringNotices, sendTouristExpiringNotices } from "@/domain/notifications";
import { prisma, resetDatabase } from "./db";
import { createMember, createRedemption } from "./fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sent: SendEmailInput[] = [];
let cityId: string;
const subjects = () => sent.map((m) => m.subject);

describe("notifications (spec §16) + cron", () => {
  beforeAll(async () => {
    await resetDatabase();
    cityId = (await runSeed(prisma, { adminEmail: "admin@test.siapp" })).cityId;
    registerBillingWebhooks();
    setEmailSinkForTests(async (m) => {
      sent.push(m);
    });
  });
  beforeEach(() => {
    sent.length = 0;
  });

  it("notifyOnce sends once per (member, kind, reference) and releases the claim when sending fails", async () => {
    const m = await createMember();
    let calls = 0;
    const send = async () => {
      calls++;
    };
    expect(await notifyOnce({ memberId: m.id, kind: "welcome", reference: "x" }, send)).toBe(true);
    expect(await notifyOnce({ memberId: m.id, kind: "welcome", reference: "x" }, send)).toBe(false);
    expect(await notifyOnce({ memberId: m.id, kind: "welcome", reference: "y" }, send)).toBe(true);
    expect(calls).toBe(2);
    expect(await notifyOnce({ memberId: m.id, kind: "no_show", reference: "z" }, async () => { throw new Error("smtp down"); })).toBe(false);
    expect(await notifyOnce({ memberId: m.id, kind: "no_show", reference: "z" }, send)).toBe(true); // retried next run
    expect(await prisma.notificationLog.count({ where: { memberId: m.id, sentAt: { not: null } } })).toBe(3);
  });

  it("welcome: once, after the first onboarding, with the free keys", async () => {
    const m = await createMember();
    await grantPlanKeys(m.id, 2, new Date(Date.now() + 30 * DAY), { reference: `free:${m.id}` });
    const input = { name: "Ana Silva", dateOfBirth: "1990-01-01", ageAttested: true as const, cityId };
    await completeOnboarding(m.id, input);
    expect(subjects()).toEqual(["you're in. sort of."]);
    expect(sent[0]).toMatchObject({ to: m.email, text: expect.stringMatching(/ana, welcome\./) });
    expect(sent[0]!.text).toContain("2 keys in your wallet");
    await completeOnboarding(m.id, { ...input, name: "Ana S." });
    expect(sent).toHaveLength(1);
  });

  it("plan keys granted: first payment, replay silent, renewal says renewed; FREE's monthly roll never emails", async () => {
    const m = await createMember();
    const plan = await prisma.plan.findFirstOrThrow({ where: { period: "MONTHLY", tier: { code: "SOCIAL" } } });
    const start = new Date();
    const end = addMonths(start, 1);
    await applyPaidPeriod({ memberId: m.id, stripeSubscriptionId: `sub_${m.id}`, planId: plan.id, periodStart: start, periodEnd: end });
    expect(subjects()).toEqual(["30 keys landed"]);
    expect(sent[0]!.text).toContain("plan keys expire with the period");
    await applyPaidPeriod({ memberId: m.id, stripeSubscriptionId: `sub_${m.id}`, planId: plan.id, periodStart: start, periodEnd: end });
    expect(sent).toHaveLength(1);
    const end2 = addMonths(end, 1);
    await applyPaidPeriod({ memberId: m.id, stripeSubscriptionId: `sub_${m.id}`, planId: plan.id, periodStart: end, periodEnd: end2 }, { now: new Date(end.getTime() + 1000) });
    expect(subjects()[1]).toBe("renewed — 30 keys landed");

    // quarterly: month 2 grant from the job emails; FREE roll doesn't
    const q = await createMember();
    const qPlan = await prisma.plan.findFirstOrThrow({ where: { period: "QUARTERLY", tier: { code: "REGULAR" } } });
    await applyPaidPeriod({ memberId: q.id, stripeSubscriptionId: `sub_${q.id}`, planId: qPlan.id, periodStart: start, periodEnd: addMonths(start, 3) });
    const free = await createMember();
    const freePlan = await prisma.plan.findFirstOrThrow({ where: { period: "MONTHLY", tier: { code: "FREE" } } });
    await prisma.subscription.create({ data: { memberId: free.id, planId: freePlan.id, status: "ACTIVE", currentPeriodStart: start, currentPeriodEnd: end, nextGrantAt: end } });
    sent.length = 0;
    const later = new Date(end.getTime() + HOUR);
    await runMonthlyGrants({ now: later, memberId: q.id });
    await runMonthlyGrants({ now: later, memberId: free.id });
    expect(sent.map((s) => [s.to, s.subject])).toEqual([[q.email, "80 keys landed"]]);
  });

  it("failed payment: invoice.payment_failed emails once per invoice", async () => {
    const m = await createMember();
    const plan = await prisma.plan.findFirstOrThrow({ where: { period: "MONTHLY", tier: { code: "SOCIAL" } } });
    await prisma.subscription.create({ data: { memberId: m.id, planId: plan.id, status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * DAY), stripeSubscriptionId: "sub_fail", firstPaidAt: new Date() } });
    const evt = (id: string) => ({ id: `evt_${id}`, type: "invoice.payment_failed", data: { object: { id, billing_reason: "subscription_cycle", subscription: "sub_fail" } } });
    expect((await handleStripeEvent(evt("in_f1"))).status).toBe("processed");
    expect(subjects()).toEqual(["your payment didn't go through"]);
    expect(sent[0]!.text).toContain("Update card");
    await handleStripeEvent(evt("in_f1")); // replay → StripeEvent dedupe
    await handleStripeEvent(evt("in_f2")); // already PAST_DUE → markPastDue changes nothing → no email
    expect(sent).toHaveLength(1);
  });

  it("event reminder: 25 h window, once per redemption, cutoff wording, skipped for cancelled or distant events", async () => {
    const soon = await createRedemption((await createMember()).id, 12);
    const late = await createRedemption((await createMember()).id, 12);
    const cancelled = await createRedemption((await createMember()).id, 12);
    const now = new Date();
    await prisma.event.update({ where: { id: soon.eventId }, data: { startsAt: new Date(now.getTime() + 20 * HOUR), endsAt: new Date(now.getTime() + 26 * HOUR) } });
    await prisma.redemption.update({ where: { id: soon.id }, data: { cancelDeadlineAt: new Date(now.getTime() - 4 * HOUR) } });
    await prisma.event.update({ where: { id: late.eventId }, data: { startsAt: new Date(now.getTime() + 30 * HOUR) } });
    await prisma.event.update({ where: { id: cancelled.eventId }, data: { startsAt: new Date(now.getTime() + 20 * HOUR) } });
    await prisma.redemption.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });

    expect(await sendEventReminders({ now })).toEqual({ sent: 1, considered: 1 });
    expect(sent[0]!.subject).toMatch(/^tomorrow — Event/);
    expect(sent[0]!.text).toContain("cancellation window has closed");
    expect(await sendEventReminders({ now })).toEqual({ sent: 0, considered: 1 });

    // still cancellable: wording names the cutoff
    const open = await createRedemption((await createMember()).id, 12);
    await prisma.event.update({ where: { id: open.eventId }, data: { startsAt: new Date(now.getTime() + 24 * HOUR) } });
    await prisma.redemption.update({ where: { id: open.id }, data: { cancelDeadlineAt: new Date(now.getTime() + 2 * HOUR) } });
    expect((await sendEventReminders({ now })).sent).toBe(1);
    expect(sent[1]!.text).toMatch(/Cancel before .* and the keys come straight back/);
  });

  it("keys expiring: within 3 days with plan keys left, once per expiry date", async () => {
    const now = new Date();
    const a = await createMember();
    await grantPlanKeys(a.id, 10, new Date(now.getTime() + 2 * DAY), { reference: `a:${a.id}` });
    const b = await createMember();
    await grantPlanKeys(b.id, 10, new Date(now.getTime() + 5 * DAY), { reference: `b:${b.id}` });
    const c = await createMember();
    await grantPlanKeys(c.id, 10, new Date(now.getTime() + 2 * DAY), { reference: `c:${c.id}` });
    await prisma.keyBalance.update({ where: { memberId: c.id }, data: { planKeys: 0 } });
    const r = await sendKeysExpiringNotices({ now });
    expect(r.sent).toBe(1);
    expect(sent.map((s) => s.to)).toEqual([a.email]);
    expect(sent[0]!.subject).toMatch(/^10 keys expire /);
    expect((await sendKeysExpiringNotices({ now })).sent).toBe(0);
    expect((await sendKeysExpiringNotices({ now: new Date(now.getTime() + 2.5 * DAY) })).sent).toBe(1); // b's turn
    expect(sent[1]!.to).toBe(b.email);
  });

  it("tourist pass expiring: within 24 h, once", async () => {
    const now = new Date();
    const m = await createMember();
    const tourist = await prisma.plan.findFirstOrThrow({ where: { period: "TOURIST_WEEK" } });
    await prisma.subscription.create({ data: { memberId: m.id, planId: tourist.id, status: "ACTIVE", currentPeriodStart: new Date(now.getTime() - 6 * DAY), currentPeriodEnd: new Date(now.getTime() + 12 * HOUR) } });
    await grantPlanKeys(m.id, 7, new Date(now.getTime() + 12 * HOUR), { reference: `t:${m.id}` });
    const far = await createMember();
    await prisma.subscription.create({ data: { memberId: far.id, planId: tourist.id, status: "ACTIVE", currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 6 * DAY) } });
    expect(await sendTouristExpiringNotices({ now })).toEqual({ sent: 1, considered: 1 });
    expect(sent[0]).toMatchObject({ to: m.email, subject: expect.stringMatching(/^your week ends /) });
    expect(sent[0]!.text).toContain("still have 7 keys");
    expect((await sendTouristExpiringNotices({ now })).sent).toBe(0);
  });

  it("no-show notice goes out when the job forfeits the keys, once", async () => {
    const r = await createRedemption((await createMember()).id, 15);
    await prisma.event.update({ where: { id: r.eventId }, data: { startsAt: new Date(Date.now() - 10 * HOUR), endsAt: new Date(Date.now() - 2 * HOUR) } });
    await markNoShows();
    expect(sent.filter((s) => s.subject.startsWith("missed — "))).toHaveLength(1);
    expect(sent[0]!.text).toContain("15 keys you spent on it are gone");
    await markNoShows();
    expect(sent).toHaveLength(1);
  });

  it("cron: bearer-protected route runs any registered job; unknown job 404; no secret = refuse", async () => {
    process.env.CRON_SECRET = "test-cron";
    const req = (job: string, auth?: string) => new Request(`http://x/api/cron/${job}`, { headers: auth ? { authorization: auth } : {} });
    expect((await cronGet(req("expire-periods"), { params: Promise.resolve({ job: "expire-periods" }) })).status).toBe(401);
    expect((await cronGet(req("expire-periods", "Bearer nope"), { params: Promise.resolve({ job: "expire-periods" }) })).status).toBe(401);
    expect((await cronGet(req("nope", "Bearer test-cron"), { params: Promise.resolve({ job: "nope" }) })).status).toBe(404);
    const res = await cronGet(req("expire-periods", "Bearer test-cron"), { params: Promise.resolve({ job: "expire-periods" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, job: "expire-periods", result: { expiredPasses: expect.any(Number) } });
    expect(cronAuthorized(req("x", "Bearer test-cron"), { CRON_SECRET: "" })).toBe(false);
    expect(isCronJobName("reconcile-balances")).toBe(true);
    await reconcileBalances({ fix: true }); // the keys-expiring test zeroed a cache row on purpose
    expect((await runCronJob("reconcile-balances")).result).toMatchObject({ ok: true, mismatches: 0 });
    // every schedule in vercel.json names a registered job
    const { readFileSync } = await import("node:fs");
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
    for (const c of vercel.crons) expect(isCronJobName(c.path.replace("/api/cron/", ""))).toBe(true);
    expect(new Set(vercel.crons.map((c) => c.path)).size).toBe(12);
  });
});
