import Link from "next/link";
import { requireOnboardedMember } from "@/lib/authz";
import { signOut } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { MemberHeader } from "@/components/member-nav";

const LABEL: Record<string, string> = { ACTIVE: "you're in", PENDING_PAYMENT: "pay to confirm", HELD: "under review", CHECKED_IN: "scanned", CANCELLED: "cancelled", NO_SHOW: "no-show", EXPIRED: "expired", DENIED: "declined" };

export default async function TicketsPage() {
  const member = await requireOnboardedMember("/app/tickets");
  const now = new Date();
  const all = await prisma.redemption.findMany({ where: { memberId: member.id }, include: { event: { include: { city: true } }, offer: true }, orderBy: { createdAt: "desc" }, take: 100 });
  const upcoming = all.filter((r) => r.event.endsAt >= now && ["ACTIVE", "PENDING_PAYMENT", "HELD"].includes(r.status)).sort((a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime());
  const past = all.filter((r) => !upcoming.includes(r));

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/sign-in" });
  }
  const Row = ({ r }: { r: (typeof all)[number] }) => (
    <Link href={`/app/tickets/${r.id}`} className="night-card flex items-center justify-between gap-3 p-4 transition hover:border-red-soft">
      <div className="min-w-0">
        <p className="truncate font-display text-lg">{r.event.title.toLowerCase()}</p>
        <p className="text-xs text-ink-muted">{formatDate(r.event.startsAt, r.event.city.timezone)} · {r.offer.name}{r.plusOneName ? ` · +1 ${r.plusOneName}` : ""}</p>
      </div>
      <span className={`shrink-0 text-xs font-semibold ${r.status === "ACTIVE" || r.status === "CHECKED_IN" ? "text-ok" : r.status === "PENDING_PAYMENT" || r.status === "HELD" ? "text-warn" : "text-ink-muted"}`}>{LABEL[r.status] ?? r.status.toLowerCase()}</span>
    </Link>
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-6 py-8">
      <MemberHeader current="/app/tickets" signOut={doSignOut} />
      <section>
        <h1 className="font-display text-3xl leading-tight">tickets<span className="text-red">.</span></h1>
        <div className="mt-4 flex flex-col gap-3">
          {upcoming.length === 0 && <p className="font-serif text-xl italic text-ink-muted">nothing yet — <Link href="/app" className="underline">find a night</Link>.</p>}
          {upcoming.map((r) => <Row key={r.id} r={r} />)}
        </div>
      </section>
      {past.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Past</h2>
          <div className="mt-3 flex flex-col gap-2 opacity-70">{past.map((r) => <Row key={r.id} r={r} />)}</div>
        </section>
      )}
    </main>
  );
}
