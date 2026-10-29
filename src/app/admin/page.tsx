import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { PageHeader } from "@/components/backoffice/page-header";
import { StatCard } from "@/components/backoffice/stat-card";
import { formatMoney } from "@/lib/format";

export default async function AdminDashboard() {
  await requireStaffPage();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [members, cities, producers, events, plans, packs, stripeEvents, openSettlements, redemptions30, shows, noShows, openFlags] = await Promise.all([
    prisma.member.count(),
    prisma.city.count({ where: { isActive: true } }),
    prisma.producer.count(),
    prisma.event.count({ where: { status: "PUBLISHED" } }),
    prisma.plan.count({ where: { isActive: true } }),
    prisma.keyPack.count({ where: { isActive: true } }),
    prisma.stripeEvent.count(),
    prisma.settlement.aggregate({ where: { status: "OPEN" }, _sum: { amountCents: true }, _count: { _all: true } }),
    prisma.redemption.count({ where: { createdAt: { gte: since }, status: { in: ["ACTIVE", "CHECKED_IN", "NO_SHOW"] } } }),
    prisma.redemption.count({ where: { createdAt: { gte: since }, status: "CHECKED_IN" } }),
    prisma.redemption.count({ where: { createdAt: { gte: since }, status: "NO_SHOW" } }),
    prisma.fraudFlag.count({ where: { status: "OPEN" } }),
  ]);
  const noShowRate = shows + noShows > 0 ? Math.round((noShows / (shows + noShows)) * 100) : null;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Last 30 days of the door, plus what's open." />
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Open settlements" value={formatMoney(openSettlements._sum.amountCents ?? 0)} hint={`${openSettlements._count._all} ${openSettlements._count._all === 1 ? "event" : "events"} to pay producers`} />
        <StatCard label="Redemptions · 30 d" value={redemptions30} hint={`${shows} scanned in`} />
        <StatCard label="No-show rate · 30 d" value={noShowRate === null ? "—" : `${noShowRate}%`} hint={`${noShows} no-shows of ${shows + noShows} decided`} />
        <StatCard label="Fraud queue" value={openFlags} hint="open flags" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Members" value={members} />
        <StatCard label="Published events" value={events} hint={`${producers} producers`} />
        <StatCard label="Active plans" value={plans} hint={`${packs} key packs`} />
        <StatCard label="Stripe events" value={stripeEvents} hint={`${cities} active ${cities === 1 ? "city" : "cities"}`} />
      </div>
    </>
  );
}
