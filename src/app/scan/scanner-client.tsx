"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ManifestEntry, QueuedScan, ScanOutcome, ScannerSummary, SyncedScan, TicketHit, TicketManifest } from "@/domain/scanner";
import { scannerLogoutAction } from "./actions";

/*
 * Door scanner (ported from EventOS's scanner-client and extended per spec §14):
 * camera QR reads (native BarcodeDetector, jsQR fallback), manual code entry,
 * name lookup, per-offer counters, dispute flagging — and an offline mode:
 * the ticket manifest is cached in localStorage, offline reads resolve against
 * it, scans are queued and replayed through /api/scan/sync when back online.
 */

type Result = ScanOutcome["result"];

interface Shown {
  result: Result;
  message: string;
  code: string;
  at: string;
  ticket?: ScanOutcome["ticket"];
  firstScanAt?: string;
  afterWindow?: ScanOutcome["afterWindow"];
  scanId?: string;
  /** Resolved from the cached list, not the server. */
  offline?: boolean;
  /** Code not in the cached list — queued for the server to decide. */
  unverified?: boolean;
}

interface Persisted {
  manifest: TicketManifest;
  queue: (QueuedScan & { provisional: Result })[];
  /** Codes admitted while offline → when, so a second offline read says "already scanned". */
  localScanned: Record<string, string>;
}

const ENDED = new Set(["CANCELLED", "EXPIRED", "DENIED", "NO_SHOW"]);
const FLOOD: Record<Result, string> = {
  OK: "bg-ok text-ink-dark",
  ALREADY_SCANNED: "bg-warn text-ink-dark",
  WINDOW_CLOSED: "bg-warn text-ink-dark",
  CANCELLED: "bg-red text-white",
  INVALID: "bg-red text-white",
};
const LABEL: Record<Result, string> = { OK: "OK — welcome in", ALREADY_SCANNED: "Already scanned", WINDOW_CLOSED: "Window closed", CANCELLED: "Cancelled", INVALID: "Invalid" };

interface DetectedBarcode {
  rawValue: string;
}
declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> };
  }
}

function storageKey(eventId: string) {
  return `siapp_scan:${eventId}`;
}
function loadPersisted(eventId: string): Partial<Persisted> | null {
  try {
    const raw = localStorage.getItem(storageKey(eventId));
    return raw ? (JSON.parse(raw) as Partial<Persisted>) : null;
  } catch {
    return null;
  }
}
function timeIn(iso: string, tz: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(iso));
}

export function ScannerClient({ initialSummary, initialManifest, device }: { initialSummary: ScannerSummary; initialManifest: TicketManifest; device: string }) {
  const eventId = initialSummary.event.id;
  const tz = initialSummary.event.timezone;
  const [summary, setSummary] = useState(initialSummary);
  const [manifest, setManifest] = useState(initialManifest);
  const [queue, setQueue] = useState<Persisted["queue"]>([]);
  const [localScanned, setLocalScanned] = useState<Record<string, string>>({});
  const [online, setOnline] = useState(true);
  const [shown, setShown] = useState<Shown | null>(null);
  const [syncReport, setSyncReport] = useState<SyncedScan[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TicketHit[] | null>(null);
  const [disputeNote, setDisputeNote] = useState("");
  const [disputeState, setDisputeState] = useState<"idle" | "open" | "sent" | "queued">("idle");
  const [now, setNow] = useState(() => Date.now());

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastCodeRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const syncingRef = useRef(false);

  const index = useMemo(() => new Map(manifest.tickets.map((t) => [t.code, t])), [manifest]);
  const offersById = useMemo(() => new Map(manifest.offers.map((o) => [o.id, o])), [manifest]);

  // ---- persistence -------------------------------------------------------
  useEffect(() => {
    const saved = loadPersisted(eventId);
    if (saved?.queue) setQueue(saved.queue);
    if (saved?.localScanned) setLocalScanned(saved.localScanned);
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
  }, [eventId]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(eventId), JSON.stringify({ manifest, queue, localScanned } satisfies Persisted));
    } catch {
      /* quota — the server still has everything */
    }
  }, [eventId, manifest, queue, localScanned]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // ---- server state ------------------------------------------------------
  const refresh = useCallback(
    async (withManifest: boolean) => {
      try {
        const res = await fetch(`/api/scan/state${withManifest ? "" : "?manifest=0"}`, { cache: "no-store" });
        if (res.status === 401) {
          window.location.href = "/scan";
          return false;
        }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { summary: ScannerSummary; manifest?: TicketManifest };
        setSummary(data.summary);
        if (data.manifest) setManifest(data.manifest);
        setOnline(true);
        return true;
      } catch {
        setOnline(false);
        return false;
      }
    },
    [],
  );

  const flush = useCallback(async () => {
    if (syncingRef.current || queueRef.current.length === 0) return;
    syncingRef.current = true;
    const batch = queueRef.current;
    try {
      const res = await fetch("/api/scan/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scans: batch.map(({ provisional: _p, ...s }) => s) }) });
      if (res.status === 401) {
        window.location.href = "/scan";
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { results: SyncedScan[] };
      const sent = new Set(batch.map((s) => `${s.code}@${s.at}`));
      setQueue((q) => q.filter((s) => !sent.has(`${s.code}@${s.at}`)));
      const surprises = data.results.filter((r) => batch.find((b) => b.code === r.code && b.at === r.at)?.provisional !== r.outcome.result);
      if (surprises.length > 0) setSyncReport((prev) => [...surprises, ...prev].slice(0, 20));
      setOnline(true);
      await refresh(true);
    } catch {
      setOnline(false);
    } finally {
      syncingRef.current = false;
    }
  }, [refresh]);

  useEffect(() => {
    const up = () => {
      setOnline(true);
      void flush();
      void refresh(true);
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const id = setInterval(() => {
      if (navigator.onLine) {
        void flush();
        void refresh(true);
      }
    }, 45_000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      clearInterval(id);
    };
  }, [flush, refresh]);

  // ---- resolving a code -------------------------------------------------
  const resolveOffline = useCallback(
    (code: string, at: string, admit: boolean): Shown => {
      const e = index.get(code);
      if (!e) return { result: "INVALID", message: "Not in the cached list — the server will double-check when you're back online", code, at, offline: true, unverified: true };
      const ticket = { ticketId: e.ticketId, redemptionId: "", memberName: e.memberName, plusOneName: e.plusOneName, photoUrl: e.photoUrl, offerName: offersById.get(e.offerId)?.name ?? "", offerType: (offersById.get(e.offerId)?.type ?? "FREE_TICKET") as NonNullable<ScanOutcome["ticket"]>["offerType"], status: e.status };
      const seen = localScanned[code];
      if (seen || e.status === "CHECKED_IN") return { result: "ALREADY_SCANNED", message: "Already scanned", code, at, ticket, firstScanAt: seen ?? e.checkedInAt ?? undefined, offline: true };
      if (ENDED.has(e.status)) return { result: "CANCELLED", message: e.status === "CANCELLED" ? "Ticket was cancelled" : "Ticket is not valid", code, at, ticket, offline: true };
      if (e.status === "PENDING_PAYMENT") return { result: "INVALID", message: "Not paid yet — no ticket", code, at, ticket, offline: true };
      if (e.status === "HELD") return { result: "INVALID", message: "Under review — do not admit", code, at, ticket, offline: true };
      const offer = offersById.get(e.offerId);
      if (offer?.validUntil && new Date(at) > new Date(offer.validUntil)) {
        const behaviour = offer.afterWindowBehaviour === "PAY_DOOR" ? "PAY_DOOR" : "REFUSE";
        if (!(behaviour === "PAY_DOOR" && admit)) {
          return { result: "WINDOW_CLOSED", message: behaviour === "PAY_DOOR" ? "Window closed — guest pays at the door" : "Window closed — refuse entry", code, at, ticket, afterWindow: { behaviour, validUntil: offer.validUntil }, offline: true };
        }
      }
      return { result: "OK", message: e.plusOneName ? `Welcome in — ${e.memberName} +1` : "Welcome in", code, at, ticket: { ...ticket, status: "CHECKED_IN" }, offline: true };
    },
    [index, offersById, localScanned],
  );

  const submitCode = useCallback(
    async (raw: string, admitAfterWindow = false) => {
      const code = raw.trim();
      if (!code || busy) return;
      const t = Date.now();
      if (!admitAfterWindow && lastCodeRef.current.code === code && t - lastCodeRef.current.at < 3000) return;
      lastCodeRef.current = { code, at: t };
      const at = new Date(t).toISOString();
      setBusy(true);
      setDisputeState("idle");
      setDisputeNote("");
      setHits(null);
      const showOffline = () => {
        const s = resolveOffline(code, at, admitAfterWindow);
        setShown(s);
        if (s.result === "OK") setLocalScanned((m) => ({ ...m, [code]: at }));
        setQueue((q) => [...q, { code, at, admitAfterWindow: admitAfterWindow || undefined, provisional: s.result }]);
        if (navigator.vibrate) navigator.vibrate(s.result === "OK" ? 80 : [60, 60, 60]);
      };
      try {
        if (!navigator.onLine) {
          showOffline();
          return;
        }
        const res = await fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, admitAfterWindow, at }) });
        if (res.status === 401) {
          window.location.href = "/scan";
          return;
        }
        const data = (await res.json()) as ScanOutcome & { error?: string };
        if (!res.ok) {
          setShown({ result: "INVALID", message: data.error ?? "Scan failed", code, at });
        } else {
          setShown({ ...data, code, at });
          if (data.ticket) {
            const fresh = data.ticket;
            setManifest((m) => ({ ...m, tickets: m.tickets.map((x) => (x.code === code ? { ...x, status: fresh.status, checkedInAt: data.checkedInAt ?? x.checkedInAt } : x)) }));
          }
        }
        setOnline(true);
        if (navigator.vibrate) navigator.vibrate(data.result === "OK" ? 80 : [60, 60, 60]);
        void flush();
        void refresh(false);
      } catch {
        setOnline(false);
        showOffline();
      } finally {
        setBusy(false);
      }
    },
    [busy, flush, refresh, resolveOffline],
  );

  // ---- camera -------------------------------------------------------------
  useEffect(() => {
    if (!scanning) return;
    let cancelled = false;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        if (window.BarcodeDetector) {
          const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
          const tick = async () => {
            if (cancelled || !videoRef.current) return;
            try {
              const codes = await detector.detect(videoRef.current);
              if (codes[0]) await submitCode(codes[0].rawValue);
            } catch {
              /* transient */
            }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        } else {
          const { default: jsQR } = await import("jsqr");
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          const tick = async () => {
            if (cancelled || !videoRef.current || !ctx) return;
            const v = videoRef.current;
            if (v.videoWidth > 0) {
              const scale = Math.min(1, 640 / v.videoWidth);
              canvas.width = Math.round(v.videoWidth * scale);
              canvas.height = Math.round(v.videoHeight * scale);
              ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const found = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
              if (found?.data) await submitCode(found.data);
            }
            timer = setTimeout(tick, 120);
          };
          timer = setTimeout(tick, 120);
        }
      } catch {
        setScanning(false);
        setCameraError("Couldn't open the camera — allow camera access, or type the code / search by name below.");
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
  }, [scanning, submitCode]);

  // ---- name lookup --------------------------------------------------------
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    const local = () => {
      const lower = q.toLowerCase();
      setHits(
        manifest.tickets
          .filter((e) => e.memberName.toLowerCase().includes(lower) || (e.plusOneName ?? "").toLowerCase().includes(lower))
          .slice(0, 20)
          .map((e) => ({ code: e.code, ticketId: e.ticketId, memberName: e.memberName, plusOneName: e.plusOneName, photoUrl: e.photoUrl, offerName: offersById.get(e.offerId)?.name ?? "", status: e.status, checkedInAt: e.checkedInAt })),
      );
    };
    const id = setTimeout(async () => {
      if (!navigator.onLine) return local();
      try {
        const res = await fetch(`/api/scan/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
        if (!res.ok) throw new Error();
        setHits(((await res.json()) as { hits: TicketHit[] }).hits);
      } catch {
        local();
      }
    }, 250);
    return () => clearTimeout(id);
  }, [query, manifest, offersById]);

  // ---- dispute ------------------------------------------------------------
  const sendDispute = useCallback(async () => {
    if (!shown || !disputeNote.trim()) return;
    if (shown.scanId && navigator.onLine) {
      try {
        const res = await fetch("/api/scan/dispute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scanId: shown.scanId, note: disputeNote.trim() }) });
        if (res.ok) {
          setDisputeState("sent");
          void refresh(false);
          return;
        }
      } catch {
        /* fall through to the queue */
      }
    }
    // Offline (or the scan itself is still queued): the note rides along with the replay.
    setQueue((q) => {
      const i = q.findIndex((s) => s.code === shown.code && s.at === shown.at);
      if (i >= 0) return q.map((s, j) => (j === i ? { ...s, disputeNote: disputeNote.trim() } : s));
      return [...q, { code: shown.code, at: shown.at, provisional: shown.result, disputeNote: disputeNote.trim() }];
    });
    setDisputeState("queued");
  }, [shown, disputeNote, refresh]);

  const ev = summary.event;
  const queued = queue.length;

  return (
    <main className="office min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 py-4">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">{device}</p>
            <h1 className="truncate font-display text-xl leading-tight">{ev.title}</h1>
            <p className="text-xs text-ink-dark-muted">
              {timeIn(ev.startsAt, tz)} → {timeIn(ev.endsAt, tz)}
              {ev.venue ? ` · ${ev.venue}` : ""}
            </p>
          </div>
          <form action={scannerLogoutAction}>
            <button className="btn btn-ghost min-h-12 !px-3 text-sm">Sign out</button>
          </form>
        </header>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold ${online ? "bg-ok/20 text-[#137a52]" : "bg-warn/25 text-[#8a5a00]"}`}>
            <span className={`h-2 w-2 rounded-full ${online ? "bg-ok" : "bg-warn"}`} />
            {online ? "Online" : "Offline — scans are queued"}
          </span>
          {queued > 0 && (
            <button onClick={() => void flush()} className="min-h-11 rounded-full bg-ink-dark px-4 font-semibold text-cream">
              {queued} queued · sync now
            </button>
          )}
          <span className="ml-auto text-ink-dark-muted">
            {summary.totals.scanned} in · {summary.totals.redeemed} redeemed
          </span>
        </div>

        {/* counters */}
        <div className="card divide-y divide-line-light text-sm">
          {summary.offers.map((o) => {
            const win = o.window;
            const minutesLeft = win ? Math.max(0, Math.ceil((new Date(win.validUntil).getTime() - now) / 60_000)) : 0;
            const open = win ? minutesLeft > 0 : false;
            return (
              <div key={o.offerId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{o.name}</p>
                  <p className="text-sm text-ink-dark-muted">{o.type.toLowerCase().replace("_", " ")}</p>
                </div>
                <div className="text-right tabular-nums">
                  {win ? (
                    <>
                      <p className={`font-semibold ${open ? "text-[#137a52]" : "text-red"}`}>{open ? `open · ${minutesLeft < 60 ? `${minutesLeft} min` : `${Math.floor(minutesLeft / 60)} h ${minutesLeft % 60} min`} left` : win.afterWindowBehaviour === "PAY_DOOR" ? "closed · pay at door" : "closed · refuse"}</p>
                      <p className="text-xs text-ink-dark-muted">
                        until {timeIn(win.validUntil, tz)} · {o.scanned} in / {o.redeemed} redeemed
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-semibold">
                        {o.scanned} in / {o.redeemed} redeemed
                      </p>
                      <p className="text-xs text-ink-dark-muted">{o.remaining} of {o.capacity} left</p>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* result */}
        {shown && (
          <section role="status" aria-live="assertive" aria-atomic="true" className={`rounded-3xl p-5 ${FLOOD[shown.result]}`}>
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
                {LABEL[shown.result]}
                {shown.offline ? " · offline" : ""}
                {shown.unverified ? " · unverified" : ""}
              </p>
              <button onClick={() => setShown(null)} aria-label="Dismiss result" className="-m-2 min-h-11 min-w-11 rounded-lg p-2 text-sm font-semibold underline underline-offset-2">
                dismiss
              </button>
            </div>
            {shown.ticket && (
              <div className="mt-3 flex flex-col items-center text-center">
                {shown.ticket.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={shown.ticket.photoUrl} alt={`Selfie of ${shown.ticket.memberName}`} className="h-56 w-56 rounded-3xl border-4 border-white/60 object-cover shadow-lg" />
                ) : (
                  <div className="flex h-56 w-56 items-center justify-center rounded-3xl border-4 border-dashed border-white/60 text-sm font-semibold opacity-80">no selfie on file — check ID</div>
                )}
                <p className="mt-3 font-display text-2xl leading-tight">{shown.ticket.memberName}</p>
                {shown.ticket.plusOneName && <p className="text-lg">+1 {shown.ticket.plusOneName}</p>}
                <p className="mt-1 text-sm opacity-80">{shown.ticket.offerName}</p>
              </div>
            )}
            <p className="mt-3 text-center font-display text-xl">{shown.message}</p>
            {shown.firstScanAt && <p className="mt-1 text-center text-sm opacity-80">first scanned {timeIn(shown.firstScanAt, tz)}</p>}
            {shown.result === "WINDOW_CLOSED" && shown.afterWindow && (
              <p className="mt-1 text-center text-sm opacity-80">window closed at {timeIn(shown.afterWindow.validUntil, tz)}</p>
            )}
            {shown.result === "WINDOW_CLOSED" && shown.afterWindow?.behaviour === "PAY_DOOR" && (
              <button onClick={() => void submitCode(shown.code, true)} disabled={busy} className="btn mt-4 w-full border-2 border-ink-dark bg-white !py-3 !text-base text-ink-dark">
                Paid at the door — admit
              </button>
            )}
            {shown.ticket && (
              <div className="mt-4 border-t border-black/15 pt-3">
                {disputeState === "idle" && (
                  <button onClick={() => setDisputeState("open")} className="min-h-11 rounded-lg px-1 text-base font-semibold underline underline-offset-2">
                    Flag dispute
                  </button>
                )}
                {disputeState === "open" && (
                  <div className="flex flex-col gap-2">
                    <textarea value={disputeNote} onChange={(e) => setDisputeNote(e.target.value)} rows={2} aria-label="Dispute note" placeholder="What's wrong? (photo doesn't match, +1 is someone else…)" className="input !bg-white/90 !text-base" />
                    <div className="flex gap-2">
                      <button onClick={() => void sendDispute()} disabled={!disputeNote.trim()} className="btn min-h-12 bg-ink-dark !px-5 !text-base text-cream">
                        Flag it
                      </button>
                      <button onClick={() => setDisputeState("idle")} className="btn btn-ghost min-h-12 !px-5 !text-base !text-ink-dark">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {disputeState === "sent" && <p className="text-sm font-semibold">Dispute flagged — it&apos;s on the member&apos;s record.</p>}
                {disputeState === "queued" && <p className="text-sm font-semibold">Dispute saved — it syncs with the scan.</p>}
              </div>
            )}
          </section>
        )}

        {syncReport.length > 0 && (
          <div className="rounded-2xl border border-warn/60 bg-warn/15 p-3 text-sm">
            <div className="flex items-center justify-between">
              <p className="font-semibold">Sync surprises</p>
              <button onClick={() => setSyncReport([])} className="min-h-11 px-2 text-sm font-semibold text-ink-dark-muted underline">
                clear
              </button>
            </div>
            <ul className="mt-1 space-y-1 text-xs">
              {syncReport.map((s) => (
                <li key={`${s.code}@${s.at}`}>
                  {timeIn(s.at, tz)} · {s.outcome.ticket?.memberName ?? s.code.slice(0, 8)} → <strong>{LABEL[s.outcome.result]}</strong>
                  {s.outcome.result === "ALREADY_SCANNED" ? " (scanned on another door)" : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* camera */}
        <div className="card relative overflow-hidden !bg-black">
          {scanning ? (
            <>
              <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline aria-label="Camera preview" />
              <button onClick={() => setScanning(false)} className="absolute bottom-3 left-1/2 min-h-12 -translate-x-1/2 rounded-full border border-white/40 bg-black/60 px-6 text-base font-semibold text-white backdrop-blur">
                Stop camera
              </button>
            </>
          ) : (
            <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 px-6 text-center text-white/70">
              <button onClick={() => { setCameraError(null); setScanning(true); }} disabled={busy} className="btn btn-primary !px-8 !py-4 !text-base">
                Start camera
              </button>
              {cameraError ? <p className="text-xs text-warn">{cameraError}</p> : <p className="text-xs">Point at the member&apos;s QR. Reads debounce for 3 s.</p>}
            </div>
          )}
        </div>

        {/* manual code */}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await submitCode(manualCode);
            setManualCode("");
          }}
          className="flex gap-2"
        >
          <input value={manualCode} onChange={(e) => setManualCode(e.target.value)} aria-label="Ticket code" placeholder="Type the ticket code" autoComplete="off" spellCheck={false} className="input min-h-12 flex-1 font-mono !text-base" />
          <button disabled={busy || !manualCode.trim()} className="btn btn-outline min-h-12 shrink-0 !px-5 !text-base">
            Check
          </button>
        </form>

        {/* lookup by name */}
        <div className="card p-3">
          <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tickets by name, plus-one or email" placeholder="Can't scan? Search by name, +1 or email" className="input min-h-12 !text-base" />
          {hits && (
            <ul className="mt-2 divide-y divide-line-light">
              {hits.length === 0 && <li className="py-2 text-sm text-ink-dark-muted">Nobody by that name on this event.</li>}
              {hits.map((h) => (
                <li key={h.ticketId} className="flex items-center gap-3 py-2">
                  {h.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={h.photoUrl} alt="" className="h-12 w-12 rounded-xl object-cover" />
                  ) : (
                    <div className="h-12 w-12 rounded-xl bg-cream" />
                  )}
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="truncate font-semibold">
                      {h.memberName}
                      {h.plusOneName ? ` +1 ${h.plusOneName}` : ""}
                    </p>
                    <p className="text-xs text-ink-dark-muted">
                      {h.offerName} · {h.status === "CHECKED_IN" && h.checkedInAt ? `in at ${timeIn(h.checkedInAt, tz)}` : h.status.toLowerCase().replace("_", " ")}
                    </p>
                  </div>
                  <button onClick={() => { setQuery(""); void submitCode(h.code); }} disabled={busy} aria-label={`Scan ${h.memberName}`} className="btn btn-outline min-h-11 !px-4 text-sm">
                    Scan
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="pb-4 text-center text-xs text-ink-dark-muted">
          Cached list from {timeIn(manifest.generatedAt, tz)} · {manifest.tickets.length} tickets. Works offline; everything syncs back.
        </p>
      </div>
    </main>
  );
}
