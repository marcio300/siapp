import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireOnboardedMember } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { formatDate, formatMoney } from "@/lib/format";
import { KeyIcon } from "@/components/key-icon";
import { Notice } from "@/components/member-nav";
import { Wordmark } from "@/components/wordmark";
import { cancelTicketAction, payTicketAction } from "../actions";

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const member = await requireOnboardedMember("/app/tickets");
  const { id } = await params;
  const sp = await searchParams;
  const r = await prisma.redemption.findUnique({ where: { id }, include: { event: { include: { city: true } }, offer: true, ticket: true } });
  if (!r || r.memberId !== member.id) notFound();
  const tz = r.event.city.timezone;
  const now = new Date();
  const qr = r.ticket ? await QRCode.toDataURL(r.ticket.qrPayload, { width: 560, margin: 1 }) : null;
  const canCancel = (r.status === "ACTIVE" && now <= r.cancelDeadlineAt) || r.status === "PENDING_PAYMENT" || r.status === "HELD";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 px-6 py-8">
      <div className="flex items-center justify-between">
        <Wordmark />
        <Link href="/app/tickets" className="text-sm text-ink-muted hover:text-ink">all tickets</Link>
      </div>
      {sp.error && <Notice tone="error">{sp.error}</Notice>}
      {sp.new && <Notice tone="ok">you&apos;re in. show this at the door with your face.</Notice>}
      {sp.paid && r.status === "PENDING_PAYMENT" && <Notice tone="ok">payment received — your ticket appears here as soon as Stripe confirms (seconds).</Notice>}
      {sp.held && <Notice tone="ok">one moment — a human is taking a quick look at this one. your spot and keys are held meanwhile.</Notice>}
      {sp.cancelled && <Notice tone="ok">cancelled. keys are back in your wallet.</Notice>}

      <section>
        <h1 className="font-display text-3xl leading-tight">{r.event.title.toLowerCase()}</h1>
        <p className="text-ink-muted">{formatDate(r.event.startsAt, tz)}{r.event.venue ? ` · ${r.event.venue}` : ""}</p>
        <p className="mt-1 text-sm text-ink-muted">{r.offer.name} · <KeyIcon className="inline h-3.5 w-3.5 text-red" /> {r.keyCost}{r.cashCents > 0 ? ` + ${formatMoney(r.cashCents)}` : ""}{r.plusOneName ? ` · +1 ${r.plusOneName}` : ""}</p>
      </section>

      {r.status === "ACTIVE" || r.status === "CHECKED_IN" ? (
        qr && (
          <section className="rounded-3xl bg-white p-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="Your ticket QR" className="mx-auto w-full max-w-xs" />
            <div className="mt-4 flex items-center gap-3 text-ink-dark">
              {r.ticket!.photoSnapshotUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.ticket!.photoSnapshotUrl} alt="" className="h-14 w-14 rounded-xl object-cover" />
              )}
              <div>
                <p className="font-semibold">{r.ticket!.memberName}</p>
                {r.ticket!.plusOneName && <p className="text-sm text-ink-dark-muted">+1 {r.ticket!.plusOneName}</p>}
                <p className="text-xs text-ink-dark-muted">{r.status === "CHECKED_IN" ? `scanned ${r.checkedInAt ? formatDate(r.checkedInAt, tz) : ""}` : "valid"}</p>
              </div>
            </div>
          </section>
        )
      ) : r.status === "PENDING_PAYMENT" ? (
        <section className="night-card p-5">
          <p className="font-display text-xl">pay to confirm<span className="text-red">.</span></p>
          <p className="mt-1 font-serif italic text-ink-muted">
            {r.paymentExpiresAt && r.paymentExpiresAt > now ? `your spot is held until ${formatDate(r.paymentExpiresAt, tz)}.` : "the payment window closed — the spot was released."}
          </p>
          {r.paymentExpiresAt && r.paymentExpiresAt > now && (
            <form action={payTicketAction} className="mt-3">
              <input type="hidden" name="redemptionId" value={r.id} />
              <button className="btn btn-primary w-full">Pay {formatMoney(r.cashCents)}</button>
            </form>
          )}
        </section>
      ) : r.status === "HELD" ? (
        <section className="night-card p-5">
          <p className="font-display text-xl">under review<span className="text-red">.</span></p>
          <p className="mt-1 font-serif italic text-ink-muted">a human is checking this one. you&apos;ll get an email either way; your keys are held, not lost.</p>
        </section>
      ) : (
        <section className="night-card p-5">
          <p className="font-display text-xl">{r.status.toLowerCase().replace("_", " ")}<span className="text-red">.</span></p>
          {r.status === "NO_SHOW" && <p className="mt-1 font-serif italic text-ink-muted">the door never saw you — those keys are gone.</p>}
        </section>
      )}

      {canCancel && (
        <details className="night-card p-4">
          <summary className="cursor-pointer text-sm text-ink-muted">
            {r.status === "ACTIVE" ? `cancel — free until ${formatDate(r.cancelDeadlineAt, tz)}` : "cancel this"}
          </summary>
          <form action={cancelTicketAction} className="mt-3 flex flex-col gap-2">
            <input type="hidden" name="redemptionId" value={r.id} />
            <p className="text-xs text-ink-muted">{r.keyCost} keys go back to your wallet{r.cashCents > 0 && r.status === "ACTIVE" ? ` and ${formatMoney(r.cashCents)} to your card` : ""}.</p>
            <button className="btn border border-red/40 text-red-soft hover:bg-red/10">Yes, cancel</button>
          </form>
        </details>
      )}
      {r.status === "ACTIVE" && now > r.cancelDeadlineAt && (
        <p className="text-xs text-ink-muted">inside the 24h window — this ticket is final.</p>
      )}
    </main>
  );
}
