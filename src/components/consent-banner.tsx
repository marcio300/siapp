"use client";

import { useEffect, useState } from "react";

/**
 * Cookie consent for the one optional tracker we run (the Meta pixel on the
 * founders page). Nothing loads until the visitor accepts; "decline" is
 * remembered just as long. Readers: `MetaPixel`. Cookie: `siapp_consent`.
 */
export const CONSENT_COOKIE = "siapp_consent";
const ONE_YEAR = 365 * 86_400;

export type Consent = "accepted" | "declined" | null;

export function readConsent(): Consent {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${CONSENT_COOKIE}=(accepted|declined)`));
  return (m?.[1] as Consent) ?? null;
}

function writeConsent(value: Exclude<Consent, null>) {
  document.cookie = `${CONSENT_COOKIE}=${value}; Max-Age=${ONE_YEAR}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  window.dispatchEvent(new CustomEvent("siapp:consent", { detail: value }));
}

export function ConsentBanner({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (enabled && readConsent() === null) setOpen(true);
  }, [enabled]);
  if (!open) return null;
  const choose = (v: Exclude<Consent, null>) => {
    writeConsent(v);
    setOpen(false);
  };
  return (
    <div role="dialog" aria-live="polite" aria-label="Cookies" className="fixed inset-x-0 bottom-0 z-40 px-4 pb-4 sm:px-6">
      <div className="night-card mx-auto flex max-w-3xl flex-col gap-3 p-4 shadow-2xl sm:flex-row sm:items-center sm:gap-5">
        <p className="flex-1 text-sm text-ink-muted">
          <span className="font-display text-ink">one cookie question<span className="text-red">.</span></span> we&apos;d like to tell Meta that our ads brought you here, so we stop paying for the ones that don&apos;t. that&apos;s a Meta pixel cookie. nothing else, ever.{" "}
          <a href="/legal/cookies" className="underline hover:text-ink">details</a>
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => choose("declined")} className="btn flex-1 border border-line text-ink-muted hover:text-ink sm:flex-none">No thanks</button>
          <button type="button" onClick={() => choose("accepted")} className="btn btn-primary flex-1 sm:flex-none">Okay</button>
        </div>
      </div>
    </div>
  );
}
