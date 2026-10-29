import Link from "next/link";

/** Links every public and member screen carries (spec §10/Phase 10). */
export function LegalFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted ${className}`}>
      <Link href="/legal/terms" className="hover:text-ink">Terms</Link>
      <Link href="/legal/privacy" className="hover:text-ink">Privacy</Link>
      <Link href="/legal/cookies" className="hover:text-ink">Cookies</Link>
      <span className="ml-auto">© {new Date().getFullYear()} SIAPP</span>
    </footer>
  );
}
