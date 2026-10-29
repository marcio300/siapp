import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, signIn } from "@/lib/auth";
import { LegalFooter } from "@/components/legal-footer";
import { Wordmark } from "@/components/wordmark";
import { isDisposableEmail } from "@/domain/fraud/disposable";

/**
 * One sign-in for members and staff: email magic link, nothing else.
 * `next` is where the link lands; the default "/" routes staff to /admin and
 * members to /app (see src/app/page.tsx). The backoffice guard sends staff
 * here with next=/admin.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; sent?: string; error?: string; deleted?: string }>;
}) {
  const { next, sent, error, deleted } = await searchParams;
  const t = await getTranslations("signIn");
  const session = await auth();
  if (session?.user) redirect(session.user.staffId ? "/admin" : "/app");

  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  async function signInWithEmail(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();
    const redirectTo = String(formData.get("next") ?? "/");
    if (!email) return;
    if (isDisposableEmail(email)) {
      redirect(`/sign-in?error=disposable&next=${encodeURIComponent(redirectTo)}`);
    }
    await signIn("email", { email, redirectTo, redirect: false });
    redirect(`/sign-in?sent=1&next=${encodeURIComponent(redirectTo)}`);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
      <div className="night-card w-full max-w-sm p-8">
        <Wordmark />
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
            {deleted && <p className="mt-4 rounded-xl border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">your account is gone. sorry to see you go — the door&apos;s still here if you change your mind.</p>}
            {error && (
              <p className="mt-4 rounded-xl border border-red/40 bg-red/10 px-4 py-3 text-sm text-red-soft">
                {error === "disposable" ? t("errorDisposable") : t("errorGeneric")}
              </p>
            )}
            <form action={signInWithEmail} className="mt-6 flex flex-col gap-3">
              <input type="hidden" name="next" value={target} />
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder={t("placeholder")}
                className="input-dark"
              />
              <button type="submit" className="btn btn-primary w-full">
                {t("submit")}
              </button>
            </form>
          </>
        )}
      </div>
      <LegalFooter className="w-full max-w-sm px-2" />
    </main>
  );
}
