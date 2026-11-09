import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { LegalFooter } from "@/components/legal-footer";
import { LocaleSwitch } from "@/components/locale-switch";
import { MetaPixel } from "@/components/meta-pixel";
import { Wordmark } from "@/components/wordmark";
import { ShareButton } from "./share-button";
import { DEFAULT_EMAIL_FROM } from "@/lib/email";

/** The bare address out of `EMAIL_FROM` ("SIAPP <hello@…>" → "hello@…") — the page tells people which sender to look for. */
function senderAddress(): string {
  const from = process.env.EMAIL_FROM || DEFAULT_EMAIL_FROM;
  return /<([^>]+)>/.exec(from)?.[1] ?? from;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("foundersThanks");
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/**
 * Post-signup screen — its own URL so the ad pixel counts the conversion
 * (`Lead`). `n` is the founder number; absent when the honeypot fired (bots
 * get a thank-you too, and nothing else).
 */
export default async function FoundersThanksPage({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const { n } = await searchParams;
  const [t, locale] = await Promise.all([getTranslations("foundersThanks"), getLocale()]);
  const number = n && /^\d{1,9}$/.test(n) ? Number(n) : null;
  const shareUrl = `${(process.env.APP_URL ?? "").replace(/\/$/, "")}/founders?utm_source=share&utm_medium=friend`;
  const selfUrl = `/founders/thanks${number !== null ? `?n=${number}` : ""}`;
  const headline = t("headline");
  const dot = headline.endsWith(".") ? headline.slice(0, -1) : headline;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 py-6 sm:py-8">
      <MetaPixel pixelId={process.env.NEXT_PUBLIC_META_PIXEL_ID} event="Lead" eventId={number !== null ? `founder-${number}` : undefined} />
      <div className="flex items-center justify-between">
        <Link href="/founders" aria-label="SIAPP"><Wordmark /></Link>
        <LocaleSwitch current={locale} next={selfUrl} />
      </div>
      <div className="flex flex-1 flex-col justify-center py-12">
        {number !== null && <p className="badge badge-red self-start">{t("badge", { number })}</p>}
        <h1 className="mt-5 font-display text-4xl leading-[1.05] tracking-tight sm:text-5xl">
          {dot}<span className="text-red">.</span>
        </h1>
        <p className="mt-4 font-serif text-2xl italic leading-snug text-ink-muted">{t("tagline")}</p>
        <ul className="mt-8 space-y-3 text-sm text-ink-muted">
          {(["step1", "step2", "step3"] as const).map((k) => (
            <li key={k} className="flex gap-3">
              <span className="text-red">—</span>
              <span>{t.rich(k, { b: (chunks) => <span className="text-ink">{chunks}</span>, sender: senderAddress() })}</span>
            </li>
          ))}
        </ul>
        <div className="mt-8 flex flex-col gap-3">
          <ShareButton url={shareUrl} labels={{ share: t("share"), copied: t("copied"), text: t("shareText"), title: t("shareTitle") }} />
          <Link href="/founders" className="btn w-full border border-line text-ink-muted hover:text-ink">{t("back")}</Link>
        </div>
      </div>
      <LegalFooter />
    </main>
  );
}
