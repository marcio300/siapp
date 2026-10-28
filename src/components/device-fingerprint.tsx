"use client";

import { useEffect } from "react";
import { recordDeviceAction } from "@/app/app/device-actions";

/**
 * Device fingerprint on login (spec §10) via the open-source FingerprintJS.
 * Computed in the browser, posted once per tab session; the server upserts
 * Device and flags fingerprints shared by too many accounts.
 */
export function DeviceFingerprint() {
  useEffect(() => {
    const key = "siapp_fp_sent";
    try {
      if (sessionStorage.getItem(key)) return;
    } catch {
      /* private mode: just send */
    }
    let cancelled = false;
    (async () => {
      try {
        const FingerprintJS = await import("@fingerprintjs/fingerprintjs");
        const agent = await FingerprintJS.load();
        const { visitorId } = await agent.get();
        if (cancelled) return;
        await recordDeviceAction(visitorId);
        try {
          sessionStorage.setItem(key, "1");
        } catch {
          /* ignore */
        }
      } catch (e) {
        console.warn("fingerprint failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
