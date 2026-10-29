import Link from "next/link";
import type { Settlement } from "@prisma/client";
import { formatDate, formatDateOnly, formatMoney } from "@/lib/format";
import { Badge } from "@/components/backoffice/badge";
import { Td } from "@/components/backoffice/table";
import { markPaidAction, reopenAction, resendStatementAction } from "./actions";

export type SettlementListRow = Settlement & {
  producer: { id: string; name: string; contactEmail: string | null };
  event: { id: string; title: string; startsAt: Date; city: { timezone: string } };
  _count: { lines: number };
};

/** One row of the settlement ledger (shared by the ledger page and the producer page). */
export function SettlementRow({ s, isAdmin, back, showProducer = true }: { s: SettlementListRow; isAdmin: boolean; back: string; showProducer?: boolean }) {
  const tz = s.event.city.timezone;
  return (
    <tr>
      {showProducer && <Td><Link href={`/admin/producers/${s.producer.id}`} className="font-medium hover:text-red">{s.producer.name}</Link></Td>}
      <Td>
        <Link href={`/admin/events/${s.event.id}`} className="hover:text-red">{s.event.title}</Link>
        <p className="text-xs text-ink-dark-muted">{formatDate(s.event.startsAt, tz)}</p>
      </Td>
      <Td align="right" className="tabular-nums">
        {formatMoney(s.amountCents, s.currency)}
        <p className="text-xs text-ink-dark-muted">{s._count.lines} scanned</p>
      </Td>
      <Td>
        <Badge tone={s.status === "PAID" ? "ok" : "warn"}>{s.status === "PAID" ? (s.amountCents === 0 ? "nothing owed" : "paid") : "open"}</Badge>
        {s.status === "PAID" && s.amountCents > 0 && <p className="text-xs text-ink-dark-muted">{s.paidAt ? formatDateOnly(s.paidAt, tz) : ""} · {s.reference}</p>}
      </Td>
      <Td className="text-xs text-ink-dark-muted">{s.emailedAt ? `sent ${formatDate(s.emailedAt, tz)}` : s.producer.contactEmail ? "not sent" : "no contact email"}</Td>
      <Td>
        <div className="flex flex-wrap items-center gap-2">
          <a href={`/api/admin/settlements/${s.id}/csv`} className="btn btn-outline !py-1 text-xs">CSV</a>
          {s.amountCents > 0 && (
            <form action={resendStatementAction}>
              <input type="hidden" name="id" value={s.id} />
              <input type="hidden" name="back" value={back} />
              <button className="btn btn-outline !py-1 text-xs">{s.emailedAt ? "Re-send" : "Send"} email</button>
            </form>
          )}
          {isAdmin && s.status === "OPEN" && (
            <form action={markPaidAction} className="flex items-center gap-1">
              <input type="hidden" name="id" value={s.id} />
              <input type="hidden" name="back" value={back} />
              <input name="reference" required placeholder="payment ref" className="input w-36 !py-1 text-xs" />
              <button className="btn btn-primary !py-1 text-xs">Mark paid</button>
            </form>
          )}
          {isAdmin && s.status === "PAID" && s.amountCents > 0 && (
            <form action={reopenAction}>
              <input type="hidden" name="id" value={s.id} />
              <input type="hidden" name="back" value={back} />
              <button className="btn btn-ghost !py-1 text-xs">Reopen</button>
            </form>
          )}
        </div>
      </Td>
    </tr>
  );
}
