import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, signIn } from "@/lib/auth";
import { LegalFooter } from "@/components/legal-footer";
import { Wordmark } from "@/components/wordmark";
import { isActiveStaffEmail } from "@/domain/identity/gate";

export const metadata = { title: "Staff sign-in", robots: { index: false, follow: false } };

/**
 * The backoffice door, separate from member sign-in so the public page can
 * stay closed before launch. A link is sent ONLY to an active StaffUser
 * email; any other address gets the same "check your inbox" screen and no
 * email (no staff-list enumeration). The backoffice guard redirects here.
 */
export default async function StaffSignInPage({ searchParams }: { searchParams: Promise<{ next?: string; sent?: string; error?: string }> }) {
  const { next, sent, error } = await searchParams;
  const t = await getTranslations("staffSignIn");
  const session = await auth();
  if (session?.user) redirect(session.user.staffId ? "/admin" : "/app");
  const target = next && next.startsWith("/admin") && !next.startsWith("//") ? next : "/admin";

  async function staffSignIn(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const redirectTo = String(formData.get("next") ?? "/admin");
    if (!email) return;
    if (await isActiveStaffEmail(email)) {
      await signIn("email", { email, redirectTo, redirect: false });
    }
    redirect(`/staff/sign-in?sent=1&next=${encodeURIComponent(redirectTo)}`);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
      <div className="night-card w-full max-w-sm p-8">
        <div className="flex items-center gap-2">
          <Wordmark tail={false} />
          <span className="rounded-md bg-ink px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bg">backoffice</span>
        </div>
        {sent ? (
          <div className="mt-8">
            <h1 className="font-display text-2xl leading-tight">{t("sentTitle")}</h1>
            <p className="mt-3 font-serif text-lg italic text-ink-muted">{t("sentTagline")}</p>
          </div>
        ) : (
          <>
            <div className="mt-8">
              <h1 className="font-display text-2xl leading-tight">{t("title")}</h1>
              <p className="mt-2 font-serif text-lg italic text-ink-muted">{t("tagline")}</p>
            </div>
            {error && <p className="mt-4 rounded-xl border border-red/40 bg-red/10 px-4 py-3 text-sm text-red-soft">sorry, that didn&apos;t work. try again.</p>}
            <form action={staffSignIn} className="mt-6 flex flex-col gap-3">
              <input type="hidden" name="next" value={target} />
              <input type="email" name="email" required autoComplete="email" placeholder="you@siapp.club" className="input-dark" />
              <button type="submit" className="btn btn-primary w-full">{t("submit")}</button>
            </form>
          </>
        )}
      </div>
      <LegalFooter className="w-full max-w-sm px-2" />
    </main>
  );
}
