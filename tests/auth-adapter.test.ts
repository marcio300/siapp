import { beforeAll, describe, expect, it } from "vitest";
import { memberAdapter } from "@/lib/auth-adapter";
import { prisma, resetDatabase } from "./db";

/**
 * The NextAuth Prisma adapter is pointed at Member. This exercises the exact
 * calls the email (magic-link) flow makes: verification token round trip,
 * user creation, account link, session creation + lookup.
 */
describe("NextAuth adapter on Member", () => {
  const adapter = memberAdapter(prisma);

  beforeAll(async () => {
    await resetDatabase();
  });

  it("creates a Member with a referral code when a new email signs in", async () => {
    const user = await adapter.createUser!({ id: "ignored", email: "new@test.siapp", emailVerified: null });
    expect(user.email).toBe("new@test.siapp");
    const member = await prisma.member.findUniqueOrThrow({ where: { id: user.id } });
    expect(member.referralCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(member.cityId).toBeNull(); // chosen during onboarding (Phase 3)

    const byEmail = await adapter.getUserByEmail!("new@test.siapp");
    expect(byEmail?.id).toBe(user.id);
  });

  it("verification tokens are single-use", async () => {
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await adapter.createVerificationToken!({ identifier: "new@test.siapp", token: "tok_1", expires });
    const used = await adapter.useVerificationToken!({ identifier: "new@test.siapp", token: "tok_1" });
    expect(used?.token).toBe("tok_1");
    expect(await adapter.useVerificationToken!({ identifier: "new@test.siapp", token: "tok_1" })).toBeNull();
  });

  it("marks the email verified, links the email account and resolves sessions to the Member", async () => {
    const user = (await adapter.getUserByEmail!("new@test.siapp"))!;
    const verifiedAt = new Date();
    const updated = await adapter.updateUser!({ id: user.id, emailVerified: verifiedAt });
    expect(updated.emailVerified?.getTime()).toBe(verifiedAt.getTime());

    await adapter.linkAccount!({ userId: user.id, type: "email", provider: "email", providerAccountId: "new@test.siapp" });
    expect((await adapter.getUserByAccount!({ provider: "email", providerAccountId: "new@test.siapp" }))?.id).toBe(user.id);

    await adapter.createSession!({ sessionToken: "sess_1", userId: user.id, expires: new Date(Date.now() + 86_400_000) });
    const found = await adapter.getSessionAndUser!("sess_1");
    expect(found?.user.id).toBe(user.id);
    expect(found?.user.email).toBe("new@test.siapp");

    await adapter.deleteSession!("sess_1");
    expect(await adapter.getSessionAndUser!("sess_1")).toBeNull();
  });
});
