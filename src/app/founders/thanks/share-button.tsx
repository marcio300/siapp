"use client";

import { useState } from "react";

/** Web Share where it exists, clipboard elsewhere (mirrors the referrals share button). */
export function ShareButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  async function share() {
    const text = "I'm on the SIAPP founder list — Lisbon's members club for nightlife. Get the founder deal before the doors open:";
    try {
      if (typeof navigator !== "undefined" && "share" in navigator) {
        await navigator.share({ title: "SIAPP founder deal", text, url });
        return;
      }
    } catch {
      /* cancelled → fall through to copy */
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }
  return (
    <button type="button" onClick={share} className="btn btn-primary w-full !py-3">
      {copied ? "copied — send it to a friend" : "Bring a friend in early"}
    </button>
  );
}
