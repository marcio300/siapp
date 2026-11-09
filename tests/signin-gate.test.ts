import { beforeAll, describe, expect, it } from "vitest";
import { runSeed } from "../prisma/seed-data";
import { setEmailSinkForTests } from "@/lib/email";
import { setSetting } from "@/lib/settings";
import { isActiveStaffEmail, signInAllowed } from "@/domain/identity/gate";
import { registerFounderLead, inviteLeads } from "@/domain/leads";
import { prisma, resetDatabase } from "./db";
import { createMember } from "./fixtures";

describe("launch switch (public sign-in gate)", () => {
  beforeAll(async () => {
    await resetDatabase();
    await runSeed(prisma, { adminEmail: "admin@test.siapp" });
    setEmailSinkForTests(async () => undefined);
  });

  it("is closed by default: strangers and un-invited leads are refused, staff / members / invited founders get in", async () => {
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "public_signin_open" } })).value).toBe(0);
    expect(await signInAllowed("stranger@example.com")).toEqual({ ok: false, reason: "closed" });
    expect(await signInAllowed("Admin@Test.siapp")).toEqual({ ok: true, via: "staff" });
    const m = await createMember();
    expect(await signInAllowed(m.email)).toEqual({ ok: true, via: "member" });
    const deleted = await createMember();
    await prisma.member.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    expect(await signInAllowed(deleted.email)).toEqual({ ok: false, reason: "closed" });

    const lead = (await registerFounderLead({ email: "lead@example.com", consent: true })).lead;
    expect(await signInAllowed("lead@example.com")).toEqual({ ok: false, reason: "closed" }); // pre-registered ≠ invited
    const staff = await prisma.staffUser.findFirstOrThrow();
    await inviteLeads([lead.id], staff.id, { paceMs: 0 });
    expect(await signInAllowed("lead@example.com")).toEqual({ ok: true, via: "invited" });
    await prisma.founderLead.update({ where: { id: lead.id }, data: { status: "UNSUBSCRIBED" } });
    expect(await signInAllowed("lead@example.com")).toEqual({ ok: false, reason: "closed" });
    await prisma.founderLead.update({ where: { id: lead.id }, data: { status: "CONVERTED" } });
    expect(await signInAllowed("lead@example.com")).toEqual({ ok: true, via: "invited" });

    const inactive = await prisma.staffUser.create({ data: { email: "ex@test.siapp", role: "OPS", isActive: false } });
    expect(await signInAllowed(inactive.email)).toEqual({ ok: false, reason: "closed" });
    expect(await isActiveStaffEmail("admin@test.siapp")).toBe(true);
    expect(await isActiveStaffEmail("ex@test.siapp")).toBe(false);
    expect(await isActiveStaffEmail("stranger@example.com")).toBe(false);
  });

  it("opens with the setting and closes again", async () => {
    await setSetting("public_signin_open", 1);
    expect(await signInAllowed("stranger@example.com")).toEqual({ ok: true, via: "open" });
    await setSetting("public_signin_open", 0);
    expect(await signInAllowed("stranger@example.com")).toEqual({ ok: false, reason: "closed" });
  });
});
