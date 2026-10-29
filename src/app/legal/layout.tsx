import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LegalFooter } from "@/components/legal-footer";
import { Wordmark } from "@/components/wordmark";

export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("legal");
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div className="flex items-center justify-between">
        <Link href="/"><Wordmark /></Link>
        <nav className="flex gap-3 text-sm text-ink-muted">
          <Link href="/legal/terms" className="hover:text-ink">{t("terms")}</Link>
          <Link href="/legal/privacy" className="hover:text-ink">{t("privacy")}</Link>
          <Link href="/legal/cookies" className="hover:text-ink">{t("cookies")}</Link>
        </nav>
      </div>
      <p className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn">{t("draft")}</p>
      <article className="legal">{children}</article>
      <LegalFooter className="mt-6" />
    </main>
  );
}
