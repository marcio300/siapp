import type { Metadata, Viewport } from "next";
import { prisma } from "@/lib/db";
import { scannerSummary, ticketManifest } from "@/domain/scanner";
import { getScannerSession } from "@/lib/scanner-auth";
import { PwaRegister } from "@/components/pwa-register";
import { Wordmark } from "@/components/wordmark";
import { scannerLoginAction } from "./actions";
import { ScannerClient } from "./scanner-client";

export const metadata: Metadata = { title: "Scanner" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, themeColor: "#141414" };
export const dynamic = "force-dynamic";

export default async function ScanPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const session = await getScannerSession();
  if (session) {
    const event = await prisma.event.findUnique({ where: { id: session.eventId }, select: { id: true } });
    if (event) {
      const [summary, manifest] = await Promise.all([scannerSummary(session.eventId), ticketManifest(session.eventId)]);
      if (summary && manifest)
        return (
          <>
            <PwaRegister />
            <ScannerClient initialSummary={summary} initialManifest={manifest} device={session.device} />
          </>
        );
    }
  }

  return (
    <main className="office min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
        <div>
          <Wordmark tone="light" />
          <h1 className="mt-6 font-display text-3xl leading-tight">
            door<span className="text-red">.</span>
          </h1>
          <p className="mt-1 font-serif italic text-ink-dark-muted">sign in with the event&apos;s scanner code and PIN.</p>
        </div>
        {sp.error && <p className="rounded-xl border border-red/40 bg-red/10 px-4 py-3 text-sm text-red">{sp.error}</p>}
        <form action={scannerLoginAction} className="card flex flex-col gap-3 p-5">
          <label className="flex flex-col gap-1">
            <span className="label">Scanner code</span>
            <input name="code" defaultValue={sp.code ?? ""} required autoCapitalize="characters" autoComplete="off" spellCheck={false} className="input !py-3 font-mono !text-base uppercase tracking-widest" placeholder="ABC123" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">PIN</span>
            <input name="pin" type="password" inputMode="numeric" pattern="[0-9]*" required autoComplete="one-time-code" className="input !py-3 font-mono !text-base tracking-widest" placeholder="••••••" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">This door (optional)</span>
            <input name="device" defaultValue={sp.device ?? ""} maxLength={40} className="input !py-3 !text-base" placeholder="Main door, Door B, VIP…" />
          </label>
          <button className="btn btn-primary mt-2 !py-3 !text-base">Open scanner</button>
        </form>
        <p className="text-xs text-ink-dark-muted">The code and PIN are on the event page in the backoffice. Five wrong PINs lock the code for 15 minutes.</p>
      </div>
    </main>
  );
}
