import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth, signIn } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { LegalFooter } from "@/components/legal-footer";
import { Wordmark } from "@/components/wordmark";
import { isDisposableEmail } from "@/domain/fraud/disposable";
import { signInAllowed } from "@/domain/identity/gate";

/**
 * Member sign-in: email magic link, nothing else. `next` is where the link
 * lands; the default "/" routes staff to /admin and members to /app (see
 * src/app/page.tsx). Staff have their own door at /staff/sign-in.
 *
 * Launch switch (setting `public_signin_open`): while closed the form is
 * tucked behind "I have an invitation" (or shown directly when the
 * invitation link carries `?email=`), and the action refuses any address the
 * gate doesn't know — the Auth.js callback enforces the same rule.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; sent?: string; error?: string; deleted?: string; email?: string }>;
}) {
  const { next, sent, error, deleted, email } = await searchParams;
  const t = await getTranslations("signIn");
  const session = await auth();
  if (session?.user) redirect(session.user.staffId ? "/admin" : "/app");
  const open = (await getSetting("public_signin_open")) === 1;
  const prefill = email && email.length <= 254 ? email : undefined;

  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  async function signInWithEmail(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();
    const redirectTo = String(formData.get("next") ?? "/");
    if (!email) return;
    const back = (code: string) => redirect(`/sign-in?error=${code}&next=${encodeURIComponent(redirectTo)}&email=${encodeURIComponent(email)}`);
    if (isDisposableEmail(email)) back("disposable");
    if (!(await signInAllowed(email)).ok) back("closed");
    await signIn("email", { email, redirectTo, redirect: false });
    redirect(`/sign-in?sent=1&next=${encodeURIComponent(redirectTo)}`);
  }

  const form = (
    <form action={signInWithEmail} className="mt-6 flex flex-col gap-3">
      <input type="hidden" name="next" value={target} />
      <input type="email" name="email" required autoComplete="email" defaultValue={prefill} placeholder={t("placeholder")} className="input-dark" />
      <button type="submit" className="btn btn-primary w-full">
        {t("submit")}
      </button>
    </form>
  );

  const errorBox = error && (
    <p className="mt-4 rounded-xl border border-red/40 bg-red/10 px-4 py-3 text-sm text-red-soft">
      {error === "disposable" ? t("errorDisposable") : error === "closed" ? t("errorClosed") : t("errorGeneric")}
    </p>
  );

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
      <div className="night-card w-full max-w-sm p-8">
        <Wordmark />
        {sent ? (
          <div className="mt-8">
            <h1 className="font-display text-2xl leading-tight">{t("sentTitle")}</h1>
            <p className="mt-3 font-serif text-lg italic text-ink-muted">{t("sentTagline")}</p>
          </div>
        ) : open ? (
          <>
            <div className="mt-8">
              <h1 className="font-display text-2xl leading-tight">{t("title")}</h1>
              <p className="mt-2 font-serif text-lg italic text-ink-muted">{t("tagline")}</p>
            </div>
            {deleted && <p className="mt-4 rounded-xl border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">your account is gone. sorry to see you go — the door&apos;s still here if you change your mind.</p>}
            {errorBox}
            {form}
          </>
        ) : (
          <>
            <div className="mt-8">
              <h1 className="font-display text-2xl leading-tight">{t("closedTitle")}</h1>
              <p className="mt-2 font-serif text-lg italic text-ink-muted">{t("closedTagline")}</p>
            </div>
            <Link href="/founders" className="btn btn-primary mt-6 w-full">{t("foundersLink")}</Link>
            {errorBox}
            {prefill || error ? (
              <>
                <p className="mt-6 text-sm text-ink-muted">{t("closedBody")}</p>
                {form}
              </>
            ) : (
              <details className="mt-6 text-sm text-ink-muted">
                <summary className="cursor-pointer underline hover:text-ink">{t("closedToggle")}</summary>
                <p className="mt-3">{t("closedBody")}</p>
                {form}
              </details>
            )}
          </>
        )}
      </div>
      {open && (
        <p className="text-center text-sm text-ink-muted">
          {t("foundersHint")}{" "}
          <Link href="/founders" className="text-ink underline hover:text-red-soft">{t("foundersLink")}</Link>
        </p>
      )}
      <LegalFooter className="w-full max-w-sm px-2" />
    </main>
  );
}
