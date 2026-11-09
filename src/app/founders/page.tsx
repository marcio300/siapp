import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import { LegalFooter } from "@/components/legal-footer";
import { KeyIcon } from "@/components/key-icon";
import { LocaleSwitch } from "@/components/locale-switch";
import { MetaPixel } from "@/components/meta-pixel";
import { Wordmark } from "@/components/wordmark";
import { utmFromQuery } from "@/domain/leads";
import { preRegisterAction } from "./actions";
import { SubmitButton } from "./submit-button";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("founders");
  const title = t("metaTitle");
  const description = t("metaDescription");
  return {
    title,
    description,
    alternates: { canonical: "/founders" },
    openGraph: { title: `${title} · SIAPP`, description, type: "website", url: "/founders", images: [{ url: "/icons/icon-512.png", width: 512, height: 512 }] },
    twitter: { card: "summary", title: `${title} · SIAPP`, description },
    robots: { index: true, follow: true },
  };
}

const ERROR_KEYS = ["invalid_email", "disposable", "consent_required", "rate_limited", "not_found", "generic"] as const;

/**
 * Pre-launch lead capture (the page ads link to). Public, dark, one form,
 * in the visitor's language (EN/PT toggle → /api/locale cookie). UTM
 * parameters on the URL are carried through hidden inputs so attribution
 * lands on the lead; `?error=` comes back from the action.
 */
export default async function FoundersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const [t, locale] = await Promise.all([getTranslations("founders"), getLocale()]);
  const errorKey = typeof sp.error === "string" ? ((ERROR_KEYS as readonly string[]).includes(sp.error) ? (sp.error as (typeof ERROR_KEYS)[number]) : "generic") : null;
  const unsubscribed = sp.unsubscribed === "1";
  const utm = utmFromQuery(sp) ?? {};
  const utmQuery = new URLSearchParams(Object.entries(utm).filter((e): e is [string, string] => Boolean(e[1])).map(([k, v]) => [`utm_${k}`, v])).toString();
  const selfUrl = `/founders${utmQuery ? `?${utmQuery}` : ""}`;
  const cities = await prisma.city.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-6 sm:py-8">
      <MetaPixel pixelId={process.env.NEXT_PUBLIC_META_PIXEL_ID} />
      <header className="flex items-center justify-between gap-4">
        <Link href="/founders" aria-label="SIAPP"><Wordmark /></Link>
        <div className="flex items-center gap-4">
          {/* No sign-in link before launch: accounts are created by invitation only (the "Send invitations" action in the backoffice). */}
          <p className="hidden whitespace-nowrap text-sm text-ink-muted sm:block">
            {t("headerNotePrefix")}{t("headerNote")}
          </p>
          <LocaleSwitch current={locale} next={selfUrl} />
        </div>
      </header>

      {/* Mobile order: pitch → form → perks (ad traffic is mostly phones); on lg the form sits beside the pitch. */}
      <section className="grid flex-1 gap-10 py-10 lg:grid-cols-[1.15fr_1fr] lg:grid-rows-[auto_auto] lg:items-start lg:gap-x-16 lg:gap-y-8 lg:py-16">
        <div className="lg:col-start-1 lg:row-start-1">
          <p className="badge badge-red self-start">{t("badge")}</p>
          <h1 className="mt-5 font-display text-4xl leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
            {t("headlineA")}<span className="text-red">,</span>{t("headlineB")}<span className="text-red">.</span>
          </h1>
          <p className="mt-5 font-serif text-2xl italic leading-snug text-ink-muted sm:text-3xl">{t("tagline")}</p>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-ink-muted">
            <strong className="font-semibold text-ink">{t("introBrand")}</strong>
            {t.rich("introBody", { keys: (chunks) => <span className="text-ink">{chunks}</span> })}
          </p>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-ink">
            {t("limitA")}<strong className="font-semibold text-red-soft">{t("limitStrong")}</strong>{t("limitB")}
          </p>
        </div>

        <div className="night-card p-6 sm:p-8 lg:col-start-2 lg:row-span-2 lg:row-start-1" id="register">
          <h2 className="font-display text-2xl leading-tight">{t("formTitle")}<span className="text-red">.</span></h2>
          <p className="mt-2 font-serif text-lg italic text-ink-muted">{t("formTagline")}</p>
          {unsubscribed && <p className="mt-4 rounded-xl border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{t("unsubscribed")}</p>}
          {errorKey && <p role="alert" className="mt-4 rounded-xl border border-red/40 bg-red/10 px-4 py-3 text-sm text-red-soft">{t(`errors.${errorKey}`)}</p>}
          <form action={preRegisterAction} className="mt-6 flex flex-col gap-3">
            <input type="hidden" name="utmQuery" value={utmQuery} />
            {Object.entries(utm).map(([k, v]) => (v ? <input key={k} type="hidden" name={`utm_${k}`} value={v} /> : null))}
            {/* Honeypot — hidden from people, filled by bots. */}
            <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
              <label htmlFor="website">Website</label>
              <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              {t("labelName")} <span className="text-xs">{t("optional")}</span>
              <input name="name" type="text" autoComplete="given-name" maxLength={80} placeholder="Ana" className="input-dark" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              {t("labelEmail")}
              <input name="email" type="email" required autoComplete="email" inputMode="email" maxLength={254} placeholder="you@example.com" className="input-dark" />
            </label>
            {cities.length > 1 && (
              <label className="flex flex-col gap-1 text-sm text-ink-muted">
                {t("labelCity")}
                <select name="cityId" defaultValue={cities[0]!.id} className="input-dark">
                  {cities.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
            )}
            {cities.length === 1 && <input type="hidden" name="cityId" value={cities[0]!.id} />}
            <label className="mt-1 flex items-start gap-3 text-sm text-ink-muted">
              <input name="consent" type="checkbox" required className="mt-1 h-4 w-4 shrink-0 accent-red" />
              <span>{t.rich("consent", { privacy: (chunks) => <Link href="/legal/privacy" className="underline hover:text-ink">{chunks}</Link> })}</span>
            </label>
            <SubmitButton pending={t("submitting")}>{t("submit")}</SubmitButton>
            <p className="text-center text-xs text-ink-muted">{t("small")}</p>
          </form>
        </div>

        <ul className="grid gap-4 sm:grid-cols-3 lg:col-start-1 lg:row-start-2">
          <Perk title={t("perk1Title")} body={t("perk1Body")} />
          <Perk title={t("perk2Title")} body={t("perk2Body")} />
          <Perk title={t("perk3Title")} body={t("perk3Body")} />
        </ul>
      </section>

      <section className="grid gap-6 border-t border-line py-10 sm:grid-cols-3">
        <Step n="1" title={t("step1Title")} body={t("step1Body")} />
        <Step n="2" title={t("step2Title")} body={t("step2Body")} />
        <Step n="3" title={t("step3Title")} body={<>{t("step3BodyA")}<KeyIcon className="inline h-4 w-4 -mt-0.5 text-red" />{t("step3BodyB")}</>} />
      </section>

      <LegalFooter className="mt-auto" />
    </main>
  );
}

function Perk({ title, body }: { title: string; body: string }) {
  return (
    <li className="rounded-2xl border border-line bg-bg-elevated/60 p-4">
      <p className="font-display text-sm leading-tight">{title}<span className="text-red">.</span></p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{body}</p>
    </li>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: React.ReactNode }) {
  return (
    <div>
      <p className="font-display text-3xl text-red">{n}</p>
      <h3 className="mt-2 font-display text-lg leading-tight">{title}<span className="text-red">.</span></h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}
