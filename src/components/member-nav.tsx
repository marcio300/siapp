import Link from "next/link";
import { Wordmark } from "@/components/wordmark";

const LINKS = [
  { href: "/app", label: "Tonight" },
  { href: "/app/wallet", label: "Wallet" },
  { href: "/app/membership", label: "Membership" },
];

/** Member app header: wordmark + the three Phase 2 screens. Sign-out is a form the pages render. */
export function MemberHeader({ current, signOut }: { current: string; signOut: () => Promise<void> }) {
  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Link href="/app">
          <Wordmark />
        </Link>
        <form action={signOut}>
          <button className="text-sm text-ink-muted hover:text-ink">Sign out</button>
        </form>
      </div>
      <nav className="flex gap-1 rounded-full border border-line bg-bg-elevated p-1 text-sm">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`flex-1 rounded-full px-3 py-1.5 text-center transition ${
              current === l.href ? "bg-red font-semibold text-white" : "text-ink-muted hover:text-ink"
            }`}
          >
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function Notice({ tone, children }: { tone: "ok" | "error"; children: React.ReactNode }) {
  return (
    <p
      className={`rounded-xl border px-4 py-3 text-sm ${
        tone === "ok" ? "border-ok/40 bg-ok/10 text-ok" : "border-red/40 bg-red/10 text-red-soft"
      }`}
    >
      {children}
    </p>
  );
}
