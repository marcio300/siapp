"use client";

import { useEffect } from "react";
import { readConsent } from "./consent-banner";

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { queue?: unknown[]; loaded?: boolean; version?: string; callMethod?: (...args: unknown[]) => void; push?: unknown };
    _fbq?: unknown;
  }
}

/**
 * Meta pixel, consent-gated (ConsentBanner). Loads only after "accepted";
 * fires PageView and, when given, one standard event (the thanks page fires
 * `Lead`). `eventId` dedupes the event if the same conversion is ever also
 * sent server-side. Does nothing without NEXT_PUBLIC_META_PIXEL_ID.
 */
export function MetaPixel({ pixelId, event, eventId }: { pixelId: string | undefined; event?: "Lead"; eventId?: string }) {
  useEffect(() => {
    if (!pixelId) return;
    let fired = false;
    const fire = () => {
      if (fired || readConsent() !== "accepted") return;
      fired = true;
      ensureFbq(pixelId);
      window.fbq?.("track", "PageView");
      if (event) window.fbq?.("track", event, {}, eventId ? { eventID: eventId } : undefined);
    };
    fire();
    const onConsent = (e: Event) => {
      if ((e as CustomEvent<string>).detail === "accepted") fire();
    };
    window.addEventListener("siapp:consent", onConsent);
    return () => window.removeEventListener("siapp:consent", onConsent);
  }, [pixelId, event, eventId]);
  return null;
}

/** The official snippet, written out instead of eval'd so it reads and lints. */
function ensureFbq(pixelId: string) {
  if (window.fbq) return;
  const fbq = function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue!.push(args);
  } as NonNullable<Window["fbq"]>;
  fbq.queue = [];
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.push = fbq;
  window.fbq = fbq;
  window._fbq = fbq;
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://connect.facebook.net/en_US/fbevents.js";
  document.head.appendChild(s);
  fbq("init", pixelId);
}
