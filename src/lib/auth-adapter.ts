import type { Adapter, AdapterUser } from "next-auth/adapters";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { generateReferralCode } from "@/lib/referral-code";

/**
 * The Prisma adapter is written against `prisma.user`; our NextAuth user is
 * `Member`, so hand it a client whose `user` delegate is the member delegate.
 * createUser/updateUser are overridden: Member needs a referralCode and has
 * no `image` column.
 */
export function memberAdapter(db: PrismaClient = prisma): Adapter {
  const mapped = {
    user: db.member,
    account: db.account,
    session: db.session,
    verificationToken: db.verificationToken,
  } as unknown as PrismaClient;
  const base = PrismaAdapter(mapped);

  return {
    ...base,
    async createUser(user) {
      const data = {
        email: user.email,
        emailVerified: user.emailVerified ?? null,
        name: user.name ?? null,
      };
      // referralCode is unique; a collision on an 8-char code is astronomically
      // rare but cheap to retry.
      for (let attempt = 0; ; attempt++) {
        try {
          const member = await db.member.create({
            data: { ...data, referralCode: generateReferralCode() },
          });
          return toAdapterUser(member);
        } catch (e) {
          if (
            attempt < 3 &&
            e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === "P2002" &&
            (e.meta?.target as string[] | undefined)?.includes("referralCode")
          ) {
            continue;
          }
          throw e;
        }
      }
    },
    async updateUser(user) {
      const member = await db.member.update({
        where: { id: user.id },
        data: {
          ...(user.email !== undefined ? { email: user.email } : {}),
          ...(user.emailVerified !== undefined ? { emailVerified: user.emailVerified } : {}),
          ...(user.name !== undefined ? { name: user.name } : {}),
        },
      });
      return toAdapterUser(member);
    },
  };
}

function toAdapterUser(member: {
  id: string;
  email: string;
  emailVerified: Date | null;
  name: string | null;
}): AdapterUser {
  return {
    id: member.id,
    email: member.email,
    emailVerified: member.emailVerified,
    name: member.name,
    image: null,
  };
}
