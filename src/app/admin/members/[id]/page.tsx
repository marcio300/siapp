import Link from "next/link";
import { notFound } from "next/navigation";
import type { KeyPool, KeyTransactionType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { getBalance, getLedger } from "@/domain/keys";
import { formatDate, formatDateOnly } from "@/lib/format";
import { Badge, type BadgeTone } from "@/components/backoffice/badge";
import { PageHeader, SectionTitle } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { WalletPools } from "@/components/backoffice/wallet-pools";
import { adjustKeysAction } from "./actions";

const POOLS: KeyPool[] = ["PLAN", "PURCHASED"];
const TYPES: KeyTransactionType[] = [
  "PLAN_GRANT",
  "PACK_PURCHASE",
  "REDEMPTION",
  "CANCELLATION_REFUND",
  "REFERRAL_BONUS",
  "EXPIRY",
  "ADMIN_ADJUSTMENT",
  "PROMO_GRANT",
];
const TYPE_TONE: Record<KeyTransactionType, BadgeTone> = {
  PLAN_GRANT: "ok",
  PACK_PURCHASE: "ok",
  REFERRAL_BONUS: "ok",
  PROMO_GRANT: "ok",
  CANCELLATION_REFUND: "neutral",
  REDEMPTION: "neutral",
  EXPIRY: "warn",
  ADMIN_ADJUSTMENT: "red",
};

export default async function MemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pool?: string; type?: string; error?: string; adjusted?: string }>;
}) {
  const staff = await requireStaffPage("OPS");
  const { id } = await params;
  const sp = await searchParams;
  const member = await prisma.member.findUnique({ where: { id }, include: { city: true } });
  if (!member) notFound();

  const pool = POOLS.includes(sp.pool as KeyPool) ? (sp.pool as KeyPool) : undefined;
  const type = TYPES.includes(sp.type as KeyTransactionType) ? (sp.type as KeyTransactionType) : undefined;
  const tz = member.city?.timezone;
  const [balance, ledger] = await Promise.all([getBalance(member.id), getLedger(member.id, { pool, type, take: 200 })]);

  return (
    <>
      <PageHeader
        title={member.name ?? member.email}
        subtitle={
          <>
            {member.name && <>{member.email} · </>}
            {member.city?.name ?? "no home city yet"} · joined {formatDateOnly(member.createdAt, tz)} · referral code{" "}
            <span className="font-mono">{member.referralCode}</span>
            {member.bannedAt && (
              <>
                {" "}
                · <Badge tone="red">banned</Badge>
              </>
            )}
          </>
        }
        actions={
          <Link href="/admin/members" className="btn btn-ghost">
            ← Members
          </Link>
        }
      />

      {sp.error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{sp.error}</p>}
      {sp.adjusted && (
        <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">
          Adjustment of {sp.adjusted} keys recorded.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <WalletPools balance={balance} timezone={tz} />
        {staff.role === "ADMIN" && (
          <form action={adjustKeysAction} className="card p-5 lg:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">Adjust keys (ADMIN)</p>
            <p className="mt-1 text-xs text-ink-dark-muted">
              Writes an ADMIN_ADJUSTMENT row — the ledger is the truth, balances are never edited directly. Plan credits
              need an active period and expire with it; negative amounts can&apos;t take a pool below zero.
            </p>
            <input type="hidden" name="memberId" value={member.id} />
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
              <label className="flex flex-col gap-1">
                <span className="label">Pool</span>
                <select name="pool" className="input" defaultValue="PURCHASED">
                  <option value="PURCHASED">Purchased</option>
                  <option value="PLAN">Plan</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="label">Amount (±)</span>
                <input name="amount" type="number" step="1" required className="input" placeholder="10 or -5" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="label">Reason (required)</span>
                <input name="reason" required minLength={3} maxLength={500} className="input" placeholder="e.g. goodwill after door issue" />
              </label>
              <button className="btn btn-primary">Record</button>
            </div>
          </form>
        )}
      </div>

      <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <SectionTitle>Ledger · {ledger.total} {ledger.total === 1 ? "row" : "rows"}{ledger.total > 200 ? " (showing 200)" : ""}</SectionTitle>
        <form className="flex flex-wrap items-center gap-2">
          <select name="pool" defaultValue={pool ?? ""} className="input w-auto">
            <option value="">All pools</option>
            {POOLS.map((p) => (
              <option key={p} value={p}>
                {p === "PLAN" ? "Plan" : "Purchased"}
              </option>
            ))}
          </select>
          <select name="type" defaultValue={type ?? ""} className="input w-auto">
            <option value="">All types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.toLowerCase().replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <button className="btn btn-outline">Filter</button>
          {(pool || type) && (
            <Link href={`/admin/members/${member.id}`} className="btn btn-ghost">
              Clear
            </Link>
          )}
        </form>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Type</Th>
            <Th>Pool</Th>
            <Th align="right">Keys</Th>
            <Th>Expires</Th>
            <Th>Note / reference</Th>
          </tr>
        </thead>
        <tbody>
          {ledger.rows.length === 0 && <EmptyRow colSpan={6}>No ledger rows{pool || type ? " for this filter" : " yet"}.</EmptyRow>}
          {ledger.rows.map((row) => (
            <tr key={row.id}>
              <Td className="whitespace-nowrap text-ink-dark-muted">{formatDate(row.createdAt, tz)}</Td>
              <Td>
                <Badge tone={TYPE_TONE[row.type]}>{row.type.toLowerCase().replace(/_/g, " ")}</Badge>
              </Td>
              <Td>{row.pool === "PLAN" ? "Plan" : "Purchased"}</Td>
              <Td align="right" className={`font-semibold ${row.amount < 0 ? "text-red" : ""}`}>
                {row.amount > 0 ? `+${row.amount}` : row.amount}
              </Td>
              <Td className="text-ink-dark-muted">{row.expiresAt ? formatDateOnly(row.expiresAt, tz) : "—"}</Td>
              <Td className="max-w-xs text-ink-dark-muted">
                {row.note}
                {row.redemptionId && <div className="font-mono text-xs">redemption {row.redemptionId.slice(0, 8)}…</div>}
                {row.reference && <div className="font-mono text-xs">{row.reference}</div>}
                {row.createdBy && <div className="text-xs">by {row.createdBy.name ?? row.createdBy.email}</div>}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
