import type { Metadata } from "next";
import Link from "next/link";
import { LegalFooter } from "@/components/legal-footer";
import { Wordmark } from "@/components/wordmark";
import { MetaPixel } from "@/components/meta-pixel";
import { ShareButton } from "./share-button";

export const metadata: Metadata = { title: "you're on the list", robots: { index: false, follow: false } };

/**
 * Post-signup screen — its own URL so an ad pixel / tag manager can count the
 * conversion on the page view later. `n` is the founder number; absent when
 * the honeypot fired (bots get a thank-you too, and nothing else).
 */
export default async function FoundersThanksPage({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const { n } = await searchParams;
  const number = n && /^\d{1,9}$/.test(n) ? Number(n) : null;
  const shareUrl = `${(process.env.APP_URL ?? "").replace(/\/$/, "")}/founders?utm_source=share&utm_medium=friend`;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 py-6 sm:py-8">
      <MetaPixel pixelId={process.env.NEXT_PUBLIC_META_PIXEL_ID} event="Lead" eventId={number !== null ? `founder-${number}` : undefined} />
      <Link href="/founders" aria-label="SIAPP"><Wordmark /></Link>
      <div className="flex flex-1 flex-col justify-center py-12">
        {number !== null && <p className="badge badge-red self-start">founder #{number}</p>}
        <h1 className="mt-5 font-display text-4xl leading-[1.05] tracking-tight sm:text-5xl">
          you&apos;re in<span className="text-red">.</span> well, nearly<span className="text-red">.</span>
        </h1>
        <p className="mt-4 font-serif text-2xl italic leading-snug text-ink-muted">your founder deal is locked. we&apos;ll be in touch when the doors open.</p>
        <ul className="mt-8 space-y-3 text-sm text-ink-muted">
          <li className="flex gap-3"><span className="text-red">—</span><span>check your inbox for a confirmation from <span className="text-ink">hello@siapp.club</span> (spam folder too — then drag it out, so the invitation lands).</span></li>
          <li className="flex gap-3"><span className="text-red">—</span><span>when we open in Lisbon you get one email with your invitation. create your account with this same address and the founder deal is already on it.</span></li>
          <li className="flex gap-3"><span className="text-red">—</span><span>nothing to pay today. nothing to cancel.</span></li>
        </ul>
        <div className="mt-8 flex flex-col gap-3">
          <ShareButton url={shareUrl} />
          <Link href="/founders" className="btn w-full border border-line text-ink-muted hover:text-ink">Back</Link>
        </div>
      </div>
      <LegalFooter />
    </main>
  );
}
