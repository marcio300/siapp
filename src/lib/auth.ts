import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import type { StaffRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { memberAdapter } from "@/lib/auth-adapter";
import { sendEmail } from "@/lib/email";
import { signInEmail } from "@/lib/email/templates";
import { isDisposableEmail } from "@/domain/fraud/disposable";

/**
 * Authentication (ported from EventOS, trimmed to the SIAPP rules): email
 * magic link ONLY — no SMS, no OAuth. Every account is a Member (CLAUDE.md:
 * "Every user is a member"); staff are Members whose email matches an active
 * StaffUser row, which is what the backoffice guard (src/lib/authz.ts) checks.
 * The Member-backed adapter lives in src/lib/auth-adapter.ts (testable without Next).
 */

const LINK_MAX_AGE_SECONDS = 15 * 60;

const emailProvider: Provider = {
  id: "email",
  type: "email",
  name: "Email",
  from: process.env.EMAIL_FROM ?? "SIAPP <hello@siapp.club>",
  maxAge: LINK_MAX_AGE_SECONDS,
  options: {},
  async sendVerificationRequest({ identifier, url }) {
    const email = signInEmail(url, LINK_MAX_AGE_SECONDS / 60);
    await sendEmail({ to: identifier, ...email });
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: memberAdapter(),
  providers: [emailProvider],
  pages: { signIn: "/sign-in" },
  session: { strategy: "database" },
  callbacks: {
    async session({ session, user }) {
      // Staff status is resolved per request from StaffUser (by email), so a
      // deactivated staff account loses the backoffice without re-login.
      const staff = await prisma.staffUser.findUnique({
        where: { email: user.email },
        select: { id: true, role: true, isActive: true },
      });
      session.user.id = user.id;
      session.user.staffId = staff?.isActive ? staff.id : null;
      session.user.staffRole = staff?.isActive ? staff.role : null;
      return session;
    },
    async signIn({ user }) {
      if (!user.email) return false;
      // Rule 7: no disposable domains, no banned members (the sign-in page
      // checks first for a friendly message; this is the enforcement).
      if (isDisposableEmail(user.email)) return false;
      const existing = await prisma.member.findUnique({
        where: { email: user.email },
        select: { bannedAt: true },
      });
      return !existing?.bannedAt;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email?: string | null;
      name?: string | null;
      image?: string | null;
      /** StaffUser id when the member is active staff; null for plain members. */
      staffId: string | null;
      staffRole: StaffRole | null;
    };
  }
}
