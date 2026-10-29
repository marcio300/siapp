"use client";

import { useEffect } from "react";

/** Registers /sw.js once per page load (member app + scanner). Silent when unsupported. */
export function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production" && !window.location.search.includes("sw=1")) return; // dev: opt in with ?sw=1
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
