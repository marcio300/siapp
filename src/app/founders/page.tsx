import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { LegalFooter } from "@/components/legal-footer";
import { KeyIcon } from "@/components/key-icon";
import { Wordmark } from "@/components/wordmark";
import { MetaPixel } from "@/components/meta-pixel";
import { utmFromQuery } from "@/domain/leads";
import { preRegisterAction } from "./actions";
import { SubmitButton } from "./submit-button";

export const dynamic = "force-dynamic";

const TITLE = "the founder deal";
const DESCRIPTION = "SIAPP is a members club for Lisbon nightlife. Pre-register before the doors open and lock in the founder deal — for good.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/founders" },
  openGraph: { title: `${TITLE} · SIAPP`, description: DESCRIPTION, type: "website", url: "/founders", images: [{ url: "/icons/icon-512.png", width: 512, height: 512 }] },
  twitter: { card: "summary", title: `${TITLE} · SIAPP`, description: DESCRIPTION },
  robots: { index: true, follow: true },
};

const ERRORS: Record<string, string> = {
  invalid_email: "sorry, that email doesn't look right. try again?",
  disposable: "sorry, throwaway email addresses don't get in. use one you'll keep.",
  consent_required: "we need your ok to contact you when we open — tick the box.",
  rate_limited: "easy. too many signups from here in a minute — try again shortly.",
  generic: "sorry, something went wrong on our side. try again in a moment.",
};

/**
 * Pre-launch lead capture (the page ads link to). Public, dark, one form.
 * UTM parameters on the URL are carried through hidden inputs so attribution
 * lands on the lead; `?error=` comes back from the action.
 */
export default async function FoundersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? (ERRORS[sp.error] ?? ERRORS.generic) : null;
  const unsubscribed = sp.unsubscribed === "1";
  const utm = utmFromQuery(sp) ?? {};
  const utmQuery = new URLSearchParams(Object.entries(utm).filter((e): e is [string, string] => Boolean(e[1])).map(([k, v]) => [`utm_${k}`, v])).toString();
  const cities = await prisma.city.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-6 sm:py-8">
      <MetaPixel pixelId={process.env.NEXT_PUBLIC_META_PIXEL_ID} />
      <header className="flex items-center justify-between">
        <Link href="/founders" aria-label="SIAPP"><Wordmark /></Link>
        {/* No sign-in link before launch: accounts are created by invitation only (the "Send invitations" action in the backoffice). */}
        <p className="whitespace-nowrap text-xs text-ink-muted sm:text-sm" title="Accounts are created by invitation when we open.">
          <span className="hidden sm:inline">member </span>sign-in opens at launch
        </p>
      </header>

      {/* Mobile order: pitch → form → perks (ad traffic is mostly phones); on lg the form sits beside the pitch. */}
      <section className="grid flex-1 gap-10 py-10 lg:grid-cols-[1.15fr_1fr] lg:grid-rows-[auto_auto] lg:items-start lg:gap-x-16 lg:gap-y-8 lg:py-16">
        <div className="lg:col-start-1 lg:row-start-1">
          <p className="badge badge-red self-start">founder deal · limited to 100 members</p>
          <h1 className="mt-5 font-display text-4xl leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
            sorry<span className="text-red">,</span> the doors aren&apos;t open yet<span className="text-red">.</span>
          </h1>
          <p className="mt-5 font-serif text-2xl italic leading-snug text-ink-muted sm:text-3xl">but the first ones in get the founder deal — forever.</p>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-ink-muted">
            <strong className="font-semibold text-ink">Sorry, It&apos;s a Private Party</strong> is a members club for Lisbon nightlife. Pay one membership, get <span className="text-ink">keys</span> every month, spend them on free or discounted tickets at the city&apos;s best events &amp; nightlife affairs. Pre-register now and your membership terms are locked at the founder deal for as long as you stay a member. After launch, nobody gets it.
          </p>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-ink">
            Founding memberships are limited to <strong className="font-semibold text-red-soft">100 members</strong>. Be on that 100.
          </p>
        </div>

        <div className="night-card p-6 sm:p-8 lg:col-start-2 lg:row-span-2 lg:row-start-1" id="register">
          <h2 className="font-display text-2xl leading-tight">get on the list<span className="text-red">.</span></h2>
          <p className="mt-2 font-serif text-lg italic text-ink-muted">takes ten seconds. we&apos;ll do the rest.</p>
          {unsubscribed && <p className="mt-4 rounded-xl border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">you&apos;re off the list. the door&apos;s still here if you change your mind.</p>}
          {error && <p role="alert" className="mt-4 rounded-xl border border-red/40 bg-red/10 px-4 py-3 text-sm text-red-soft">{error}</p>}
          <form action={preRegisterAction} className="mt-6 flex flex-col gap-3">
            <input type="hidden" name="utmQuery" value={utmQuery} />
            {Object.entries(utm).map(([k, v]) => (v ? <input key={k} type="hidden" name={`utm_${k}`} value={v} /> : null))}
            {/* Honeypot — hidden from people, filled by bots. */}
            <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
              <label htmlFor="website">Website</label>
              <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              first name <span className="text-xs">(optional)</span>
              <input name="name" type="text" autoComplete="given-name" maxLength={80} placeholder="Ana" className="input-dark" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              email
              <input name="email" type="email" required autoComplete="email" inputMode="email" maxLength={254} placeholder="you@example.com" className="input-dark" />
            </label>
            {cities.length > 1 && (
              <label className="flex flex-col gap-1 text-sm text-ink-muted">
                your city
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
              <span>
                contact me when SIAPP opens and keep my founder deal. I&apos;m 24 or older. see the <Link href="/legal/privacy" className="underline hover:text-ink">privacy notice</Link>.
              </span>
            </label>
            <SubmitButton pending="locking it in…">Lock in my founder deal</SubmitButton>
            <p className="text-center text-xs text-ink-muted">no payment today. one email when we open. unsubscribe any time.</p>
          </form>
        </div>

        <ul className="grid gap-4 sm:grid-cols-3 lg:col-start-1 lg:row-start-2">
          <Perk title="locked forever" body="the best terms we'll ever offer, fixed for as long as you stay a member. never on sale again." />
          <Perk title="first through the door" body="you're invited to create your account before the public launch — and before the private sales open." />
          <Perk title="no spam, no card" body="one email when we open. nothing to pay today, nothing to cancel." />
        </ul>
      </section>

      <section className="grid gap-6 border-t border-line py-10 sm:grid-cols-3">
        <Step n="1" title="pre-register" body="leave your email. you get a founder number and a confirmation — that's it." />
        <Step n="2" title="we open the doors" body="Lisbon first. you get the invitation before anyone else, with the founder deal already applied." />
        <Step n="3" title="spend your keys" body={<>every month your membership gives you <KeyIcon className="inline h-4 w-4 -mt-0.5 text-red" /> keys. spend them on free or discounted entry at partner parties. show the QR at the door. you&apos;re in.</>} />
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
