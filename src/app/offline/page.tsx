import Link from "next/link";
import { Wordmark } from "@/components/wordmark";

export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 px-6 py-8">
      <Wordmark />
      <h1 className="mt-6 font-display text-3xl leading-tight">
        sorry, no signal<span className="text-red">.</span>
      </h1>
      <p className="font-serif text-lg italic text-ink-muted">tickets you&apos;ve opened before are still here. everything else needs the network.</p>
      <Link href="/app/tickets" className="btn btn-primary mt-4 w-full !py-3">Open my tickets</Link>
    </main>
  );
}
