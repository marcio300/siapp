import Link from "next/link";
import { requireOnboardedMember } from "@/lib/authz";
import { signOut } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getBalance } from "@/domain/keys";
import { getMembership } from "@/domain/billing";
import { formatDateOnly } from "@/lib/format";
import { utcToLocal } from "@/lib/time";
import { KeyIcon } from "@/components/key-icon";
import { MemberHeader } from "@/components/member-nav";
import { EventCard } from "@/components/event-card";

const DAY = 86_400_000;
const TYPE_FILTER: Record<string, string> = { free: "FREE_TICKET", discount: "DISCOUNT_TICKET", guestlist: "GUESTLIST" };

/** Member home: this week in your city (spec §15). */
export default async function MemberHome({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const member = await requireOnboardedMember();
  const sp = await searchParams;
  const now = new Date();
  const tz = member.city?.timezone ?? "Europe/Lisbon";
  const [balance, membership] = await Promise.all([getBalance(member.id), getMembership(member.id)]);

  const horizon = new Date(now.getTime() + 7 * DAY);
  const events = await prisma.event.findMany({
    where: {
      status: "PUBLISHED",
      ...(member.cityId ? { cityId: member.cityId } : {}),
      endsAt: { gte: now },
      startsAt: { lte: horizon },
      ...(sp.tag ? { tags: { has: sp.tag } } : {}),
      ...(sp.type && TYPE_FILTER[sp.type] ? { offers: { some: { type: TYPE_FILTER[sp.type] as never } } } : {}),
    },
    include: { offers: { orderBy: { sortOrder: "asc" } } },
    orderBy: { startsAt: "asc" },
  });
  const byDay = events.filter((e) => !sp.day || utcToLocal(e.startsAt, tz).date === sp.day);
  const days = [...new Set(events.map((e) => utcToLocal(e.startsAt, tz).date))];
  const tags = [...new Set(events.flatMap((e) => e.tags))].slice(0, 12);

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/sign-in" });
  }
  const link = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ day: sp.day, type: sp.type, tag: sp.tag, ...over })) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/app?${s}` : "/app";
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-6 py-8">
      <MemberHeader current="/app" signOut={doSignOut} />

      <Link href="/app/wallet" className="flex items-center justify-between rounded-2xl border border-line bg-bg-elevated px-4 py-3">
        <span className="flex items-center gap-2 font-display text-2xl"><KeyIcon className="h-5 w-5 text-red" />{balance.total}</span>
        <span className="text-xs text-ink-muted">
          {balance.planKeysExpireAt ? `${balance.planKeys} expire ${formatDateOnly(balance.planKeysExpireAt, tz)} · ` : ""}
          {membership.tierCode.toLowerCase()}
        </span>
      </Link>

      <section>
        <h1 className="font-display text-3xl leading-tight">
          this week in {member.city?.name.toLowerCase() ?? "town"}<span className="text-red">.</span>
        </h1>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
          <Link href={link({ day: undefined })} className={`shrink-0 rounded-full border px-3 py-1 text-sm ${!sp.day ? "border-red bg-red/10" : "border-line text-ink-muted"}`}>all days</Link>
          {days.map((d) => {
            const date = new Date(`${d}T12:00:00Z`);
            const label = d === utcToLocal(now, tz).date ? "today" : d === utcToLocal(new Date(now.getTime() + DAY), tz).date ? "tomorrow" : date.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }).toLowerCase();
            return (
              <Link key={d} href={link({ day: d })} className={`shrink-0 rounded-full border px-3 py-1 text-sm ${sp.day === d ? "border-red bg-red/10" : "border-line text-ink-muted"}`}>{label}</Link>
            );
          })}
        </div>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1 text-xs [scrollbar-width:none]">
          {[["free", "free entry"], ["discount", "discounted"], ["guestlist", "guest list"]].map(([k, l]) => (
            <Link key={k} href={link({ type: sp.type === k ? undefined : k })} className={`shrink-0 rounded-full border px-2.5 py-1 ${sp.type === k ? "border-red bg-red/10" : "border-line text-ink-muted"}`}>{l}</Link>
          ))}
          {tags.map((t) => (
            <Link key={t} href={link({ tag: sp.tag === t ? undefined : t })} className={`shrink-0 rounded-full border px-2.5 py-1 ${sp.tag === t ? "border-red bg-red/10" : "border-line text-ink-muted"}`}>#{t}</Link>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        {byDay.length === 0 && (
          <p className="font-serif text-xl italic text-ink-muted">sorry, nothing {sp.day ? "that day" : "this week"} — check back soon.</p>
        )}
        {byDay.map((e) => (
          <EventCard key={e.id} event={e} offers={e.offers} tierCode={membership.tierCode} timezone={tz} now={now} />
        ))}
      </section>
    </main>
  );
}
