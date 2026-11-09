import Link from "next/link";
import { getTranslations } from "next-intl/server";

/** Links every public and member screen carries (spec §10/Phase 10). */
export async function LegalFooter({ className = "" }: { className?: string }) {
  const t = await getTranslations("legal");
  return (
    <footer className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted ${className}`}>
      <Link href="/legal/terms" className="hover:text-ink">{t("terms")}</Link>
      <Link href="/legal/privacy" className="hover:text-ink">{t("privacy")}</Link>
      <Link href="/legal/cookies" className="hover:text-ink">{t("cookies")}</Link>
      <span className="ml-auto">© {new Date().getFullYear()} SIAPP</span>
    </footer>
  );
}
