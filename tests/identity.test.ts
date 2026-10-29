import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { decryptFile, encryptFile } from "@/lib/media/crypto";
import { makeMemoryStorage, setMediaStorageForTests } from "@/lib/media/storage";
import { isDisposableEmail, DISPOSABLE_DOMAIN_COUNT } from "@/domain/fraud";
import { OnboardingError, ageAt, completeOnboarding, deleteIdPhoto, purgeIdPhotos, readIdPhoto, storeIdPhoto, storeSelfie, verificationStatus, PhotoError } from "@/domain/identity";
import { BillingError, startTouristPassCheckout, setBillingStripeForTests, type BillingStripe } from "@/domain/billing";
import { prisma, resetDatabase } from "./db";
import { createMember } from "./fixtures";

const DAY = 86_400_000;
const yearsAgo = (y: number, extraDays = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - y);
  return new Date(d.getTime() + extraDays * DAY).toISOString().slice(0, 10);
};

describe("identity", () => {
  beforeAll(async () => {
    await resetDatabase();
    await runSeed(prisma, { adminEmail: "admin@test.siapp" });
  });

  describe("disposable emails", () => {
    it("blocks known domains and their subdomains, allows the rest", () => {
      expect(DISPOSABLE_DOMAIN_COUNT).toBeGreaterThan(1000);
      expect(isDisposableEmail("x@mailinator.com")).toBe(true);
      expect(isDisposableEmail("x@MAILINATOR.com")).toBe(true);
      expect(isDisposableEmail("x@sub.mailinator.com")).toBe(true);
      expect(isDisposableEmail("x@gmail.com")).toBe(false);
      expect(isDisposableEmail("x@erasmuslifelisboa.com")).toBe(false);
      expect(isDisposableEmail("not-an-email")).toBe(false);
    });
  });

  describe("onboarding", () => {
    it("rejects members under 24, missing attestation and inactive cities", async () => {
      const m = await createMember();
      const city = await prisma.city.findFirstOrThrow();
      const base = { name: "Ana", dateOfBirth: yearsAgo(30), ageAttested: true as const, cityId: city.id };
      await expect(completeOnboarding(m.id, { ...base, dateOfBirth: yearsAgo(24, 1) })).rejects.toThrow(/24\+/);
      await expect(completeOnboarding(m.id, { ...base, ageAttested: false as never })).rejects.toBeInstanceOf(OnboardingError);
      await expect(completeOnboarding(m.id, { ...base, dateOfBirth: "2030-01-01" })).rejects.toBeInstanceOf(OnboardingError);
      await expect(completeOnboarding(m.id, { ...base, name: "A" })).rejects.toBeInstanceOf(OnboardingError);
      const inactive = await prisma.city.create({ data: { name: "Porto", country: "PT", timezone: "Europe/Lisbon", currency: "EUR", isActive: false } });
      await expect(completeOnboarding(m.id, { ...base, cityId: inactive.id })).rejects.toThrow(/active city/);
      expect((await prisma.member.findUniqueOrThrow({ where: { id: m.id } })).onboardedAt).toBeNull();
    });

    it("exactly 24 today passes; 24 tomorrow fails", () => {
      const today = new Date("2026-10-28T12:00:00Z");
      expect(ageAt(new Date("2002-10-28T00:00:00Z"), today)).toBe(24);
      expect(ageAt(new Date("2002-10-29T00:00:00Z"), today)).toBe(23);
    });

    it("completes the profile, records a referral once and stores a partner token", async () => {
      const referrer = await createMember();
      // A code is only active while the referrer is on a paid, non-tourist plan (spec §9).
      const paidPlan = await prisma.plan.findFirstOrThrow({ where: { period: "MONTHLY", tier: { code: "SOCIAL" } } });
      await prisma.subscription.create({ data: { memberId: referrer.id, planId: paidPlan.id, status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000), stripeSubscriptionId: `sub_${referrer.id}`, firstPaidAt: new Date() } });
      const m = await createMember();
      const city = await prisma.city.findFirstOrThrow({ where: { isActive: true } });
      const token = "eyJhbGciOiJSUzI1NiJ9.eyJzb3VyY2UiOiJFTEwifQ.c2ln";
      const result = await completeOnboarding(m.id, {
        name: "  Ana Silva ",
        dateOfBirth: yearsAgo(28),
        ageAttested: true,
        cityId: city.id,
        referralCode: referrer.referralCode.toLowerCase(),
        partnerClaimToken: token,
      });
      expect(result).toEqual({ referral: "recorded", partnerClaim: "stored" });
      const saved = await prisma.member.findUniqueOrThrow({ where: { id: m.id } });
      expect(saved).toMatchObject({ name: "Ana Silva", cityId: city.id, partnerClaimToken: token });
      expect(saved.onboardedAt).not.toBeNull();
      expect(saved.ageAttestedAt).not.toBeNull();
      expect(await prisma.referral.findUnique({ where: { inviteeId: m.id } })).toMatchObject({ referrerId: referrer.id, status: "PENDING" });
      expect(verificationStatus(saved)).toMatchObject({ onboarded: true, selfie: false, canRedeem: false, nextStep: "/app/profile" });

      // Re-running keeps the first attestation and never duplicates the referral.
      const again = await completeOnboarding(m.id, { name: "Ana", dateOfBirth: yearsAgo(28), ageAttested: true, cityId: city.id, referralCode: referrer.referralCode });
      expect(again.referral).toBe("already_referred");
      expect(await prisma.referral.count({ where: { inviteeId: m.id } })).toBe(1);
      // Own code and unknown codes are reported, not recorded.
      const other = await createMember();
      expect((await completeOnboarding(other.id, { name: "Bo", dateOfBirth: yearsAgo(40), ageAttested: true, cityId: city.id, referralCode: other.referralCode })).referral).toBe("self");
      expect((await completeOnboarding(other.id, { name: "Bo", dateOfBirth: yearsAgo(40), ageAttested: true, cityId: city.id, referralCode: "NOPE1234" })).referral).toBe("unknown_code");
      expect((await completeOnboarding(other.id, { name: "Bo", dateOfBirth: yearsAgo(40), ageAttested: true, cityId: city.id, partnerClaimToken: "garbage" })).partnerClaim).toBe("invalid");
    });
  });

  describe("photos", () => {
    const storage = makeMemoryStorage();
    beforeAll(() => setMediaStorageForTests(storage));

    it("encrypts and decrypts round-trip with the mime type", () => {
      const blob = encryptFile(Buffer.from("hello"), "image/png");
      expect(blob.toString("utf8")).not.toContain("hello");
      expect(decryptFile(blob)).toEqual({ data: Buffer.from("hello"), mime: "image/png" });
      blob[blob.length - 1] ^= 1;
      expect(() => decryptFile(blob)).toThrow();
    });

    it("selfie: validated, stored, replaces the previous one; verification then allows redemption", async () => {
      const m = await createMember();
      await expect(storeSelfie(m.id, { data: Buffer.alloc(0), contentType: "image/jpeg" })).rejects.toBeInstanceOf(PhotoError);
      await expect(storeSelfie(m.id, { data: Buffer.from("x"), contentType: "text/plain" })).rejects.toBeInstanceOf(PhotoError);
      const url1 = await storeSelfie(m.id, { data: Buffer.from("face-1"), contentType: "image/jpeg" });
      const url2 = await storeSelfie(m.id, { data: Buffer.from("face-2"), contentType: "image/png" });
      expect(storage.files.has(url1)).toBe(false);
      expect(storage.files.get(url2)?.toString()).toBe("face-2");
      const saved = await prisma.member.findUniqueOrThrow({ where: { id: m.id } });
      expect(saved.selfieUrl).toBe(url2);
      await prisma.member.update({ where: { id: m.id }, data: { onboardedAt: new Date(), emailVerified: new Date() } });
      expect(verificationStatus(await prisma.member.findUniqueOrThrow({ where: { id: m.id } })).canRedeem).toBe(true);
    });

    it("ID photo: stored encrypted, readable by staff, gates the tourist pass, purged after 30 days", async () => {
      const m = await createMember();
      const fakeStripe = { customers: { create: async () => ({ id: "cus_t" }) }, checkout: { sessions: { create: async () => ({ id: "cs_t", url: "https://x" }) } }, subscriptions: {
      async cancel() {
        return {};
      }, retrieve: async () => ({ id: "", items: { data: [] } }), update: async () => ({}) }, billingPortal: { sessions: { create: async () => ({ url: "" }) } }, refunds: { create: async () => ({ id: "re_x" }) } } as BillingStripe;
      setBillingStripeForTests(fakeStripe);
      const touristPrice = await prisma.planPrice.findFirstOrThrow({ where: { plan: { period: "TOURIST_WEEK" } } });
      await prisma.planPrice.update({ where: { id: touristPrice.id }, data: { stripePriceId: "price_tourist" } });
      await expect(startTouristPassCheckout(m.id)).rejects.toThrow(/ID first/);

      const url = await storeIdPhoto(m.id, { data: Buffer.from("passport-bytes"), contentType: "image/jpeg" });
      expect(storage.files.get(url)?.toString()).not.toContain("passport-bytes"); // encrypted at rest
      expect(await readIdPhoto(m.id)).toEqual({ data: Buffer.from("passport-bytes"), mime: "image/jpeg" });
      await expect(startTouristPassCheckout(m.id)).resolves.toMatchObject({ sessionId: "cs_t" });

      // Not yet 30 days: kept. Day 31: purged, storage cleared, columns nulled.
      expect(await purgeIdPhotos({ now: new Date(Date.now() + 29 * DAY) })).toEqual({ purged: 0 });
      expect(await purgeIdPhotos({ now: new Date(Date.now() + 31 * DAY) })).toEqual({ purged: 1 });
      expect(storage.files.has(url)).toBe(false);
      const saved = await prisma.member.findUniqueOrThrow({ where: { id: m.id } });
      expect(saved.idPhotoUrl).toBeNull();
      expect(await readIdPhoto(m.id)).toBeNull();
      expect(await deleteIdPhoto(m.id)).toBe(false);
      expect(await startTouristPassCheckout(m.id).catch((e) => e)).toBeInstanceOf(BillingError);
    });
  });
});
