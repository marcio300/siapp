import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { PageHeader } from "@/components/backoffice/page-header";
import { StatCard } from "@/components/backoffice/stat-card";

export default async function AdminDashboard() {
  await requireStaffPage();
  const [members, cities, producers, events, plans, packs, stripeEvents] = await Promise.all([
    prisma.member.count(),
    prisma.city.count({ where: { isActive: true } }),
    prisma.producer.count(),
    prisma.event.count({ where: { status: "PUBLISHED" } }),
    prisma.plan.count({ where: { isActive: true } }),
    prisma.keyPack.count({ where: { isActive: true } }),
    prisma.stripeEvent.count(),
  ]);

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Phase 0 — the shell is up; redemptions, revenue and no-show rate arrive with their phases." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Members" value={members} />
        <StatCard label="Published events" value={events} hint={`${producers} producers`} />
        <StatCard label="Active plans" value={plans} hint={`${packs} key packs`} />
        <StatCard label="Stripe events" value={stripeEvents} hint={`${cities} active ${cities === 1 ? "city" : "cities"}`} />
      </div>
    </>
  );
}
