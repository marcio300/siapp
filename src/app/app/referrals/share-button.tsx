"use client";

import { useState } from "react";

/** Native share sheet when the browser has one, clipboard otherwise. */
export function ShareButton({ link, text }: { link: string; text: string }) {
  const [done, setDone] = useState<"shared" | "copied" | null>(null);
  async function share() {
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: "Sorry, it's a private party", text, url: link });
        setDone("shared");
        return;
      }
    } catch {
      /* user dismissed the sheet — fall back to copying */
    }
    try {
      await navigator.clipboard.writeText(link);
      setDone("copied");
    } catch {
      window.prompt("Copy your link", link);
    }
  }
  return (
    <button type="button" onClick={share} className="btn btn-primary w-full !py-3 !text-base">
      {done === "shared" ? "Shared" : done === "copied" ? "Link copied" : "Share your link"}
    </button>
  );
}
