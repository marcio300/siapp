import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";
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
  searchParams: Promise<{ next?: string; sent?: string; error?: string }>;
}) {
  const { next, sent, error } = await searchParams;
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
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="night-card w-full max-w-sm p-8">
        <Wordmark />
        {sent ? (
          <div className="mt-8">
            <h1 className="font-display text-2xl leading-tight">check your inbox.</h1>
            <p className="mt-3 font-serif text-lg italic text-ink-muted">
              the link is your key — it works once and expires in 15 minutes.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-8">
              <h1 className="font-display text-2xl leading-tight">sorry, members only.</h1>
              <p className="mt-2 font-serif text-lg italic text-ink-muted">
                we&apos;ll email you a sign-in link. no password, ever.
              </p>
            </div>
            {error && (
              <p className="mt-4 rounded-xl border border-red/40 bg-red/10 px-4 py-3 text-sm text-red-soft">
                {error === "disposable"
                  ? "sorry, throwaway email addresses don't get in. use one you'll keep."
                  : "sorry, we couldn't sign you in with that address."}
              </p>
            )}
            <form action={signInWithEmail} className="mt-6 flex flex-col gap-3">
              <input type="hidden" name="next" value={target} />
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="input-dark"
              />
              <button type="submit" className="btn btn-primary w-full">
                Email me a link
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
