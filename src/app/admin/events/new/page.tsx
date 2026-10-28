import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { PageHeader } from "@/components/backoffice/page-header";
import { createEventAction } from "../actions";
import { EventForm } from "../event-form";

export default async function NewEventPage({ searchParams }: { searchParams: Promise<{ error?: string; producerId?: string }> }) {
  await requireStaffPage("OPS");
  const sp = await searchParams;
  const producers = await prisma.producer.findMany({ include: { city: true }, orderBy: { name: "asc" } });
  const tz = producers.find((p) => p.id === sp.producerId)?.city.timezone ?? producers[0]?.city.timezone ?? "Europe/Lisbon";
  return (
    <>
      <PageHeader title="New event" subtitle="Saved as a draft. Add offers, then publish. The scanner PIN is shown once after creation." actions={<Link href="/admin/events" className="btn btn-ghost">← Events</Link>} />
      {sp.error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{sp.error}</p>}
      {producers.length === 0 ? (
        <p className="card p-5 text-sm">Create a <Link href="/admin/producers" className="underline">producer</Link> first.</p>
      ) : (
        <div className="card p-5">
          <EventForm timezone={tz} producers={producers} defaultProducerId={sp.producerId} action={createEventAction} submitLabel="Create draft" />
        </div>
      )}
    </>
  );
}
