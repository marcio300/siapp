"use client";

import { useState } from "react";

type Labels = { share: string; copied: string; text: string; title: string };

/** Web Share where it exists, clipboard elsewhere (mirrors the referrals share button). */
export function ShareButton({ url, labels }: { url: string; labels: Labels }) {
  const [copied, setCopied] = useState(false);
  async function share() {
    try {
      if (typeof navigator !== "undefined" && "share" in navigator) {
        await navigator.share({ title: labels.title, text: labels.text, url });
        return;
      }
    } catch {
      /* cancelled → fall through to copy */
    }
    try {
      await navigator.clipboard.writeText(`${labels.text} ${url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }
  return (
    <button type="button" onClick={share} className="btn btn-primary w-full !py-3">
      {copied ? labels.copied : labels.share}
    </button>
  );
}
