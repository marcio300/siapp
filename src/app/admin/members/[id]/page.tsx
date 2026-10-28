import Link from "next/link";
import { notFound } from "next/navigation";
import type { KeyPool, KeyTransactionType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { getBalance, getLedger } from "@/domain/keys";
import { getMembership } from "@/domain/billing";
import { deviceOverlap } from "@/domain/fraud";
import { verificationStatus } from "@/domain/identity";
import { banMemberAction, reviewFlagAction, unbanMemberAction } from "@/app/admin/fraud/actions";
import { formatDate, formatDateOnly } from "@/lib/format";
import { Badge, statusTone, type BadgeTone } from "@/components/backoffice/badge";
import { KeyIcon } from "@/components/key-icon";
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
  searchParams: Promise<{ pool?: string; type?: string; error?: string; adjusted?: string; banned?: string; unbanned?: string; reviewed?: string }>;
}) {
  const staff = await requireStaffPage("OPS");
  const { id } = await params;
  const sp = await searchParams;
  const member = await prisma.member.findUnique({ where: { id }, include: { city: true, attendanceStats: true } });
  if (!member) notFound();
  const verification = verificationStatus(member);

  const pool = POOLS.includes(sp.pool as KeyPool) ? (sp.pool as KeyPool) : undefined;
  const type = TYPES.includes(sp.type as KeyTransactionType) ? (sp.type as KeyTransactionType) : undefined;
  const tz = member.city?.timezone;
  const [balance, ledger, membership, devices, flags] = await Promise.all([
    getBalance(member.id),
    getLedger(member.id, { pool, type, take: 200 }),
    getMembership(member.id),
    deviceOverlap(member.id),
    prisma.fraudFlag.findMany({ where: { memberId: member.id }, orderBy: { createdAt: "desc" }, take: 50, include: { reviewedBy: { select: { name: true, email: true } } } }),
  ]);
  const backPath = `/admin/members/${member.id}`;
  const sub = membership.subscription;

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
      {sp.banned && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Member banned.</p>}
      {sp.unbanned && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Ban lifted.</p>}
      {sp.reviewed && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Flag {sp.reviewed}.</p>}

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <div className="card flex gap-4 p-5">
          {member.selfieUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={member.selfieUrl} alt="Selfie" className="h-24 w-24 shrink-0 rounded-xl border border-line-light object-cover" />
          ) : (
            <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl border border-dashed border-line-light text-xs text-ink-dark-muted">no selfie</div>
          )}
          <div className="min-w-0 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">Identity</p>
            <ul className="mt-2 space-y-1">
              <li><Badge tone={verification.emailVerified ? "ok" : "warn"}>email {verification.emailVerified ? "verified" : "unverified"}</Badge></li>
              <li><Badge tone={verification.onboarded ? "ok" : "warn"}>{verification.onboarded ? "onboarded" : "not onboarded"}</Badge></li>
              <li><Badge tone={verification.selfie ? "ok" : "warn"}>{verification.selfie ? "selfie on file" : "no selfie"}</Badge></li>
            </ul>
            <p className="mt-2 text-xs text-ink-dark-muted">
              {member.dateOfBirth ? `born ${formatDateOnly(member.dateOfBirth, "UTC")}` : "no DOB"}
              {member.ageAttestedAt ? ` · 24+ attested ${formatDateOnly(member.ageAttestedAt, tz)}` : ""}
            </p>
          </div>
        </div>
        <div className="card p-5 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">ID photo (tourists)</p>
          {member.idPhotoUploadedAt ? (
            <>
              <a href={`/api/admin/id-photo/${member.id}`} target="_blank" rel="noreferrer" className="mt-2 block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/admin/id-photo/${member.id}`} alt="ID photo" className="h-24 rounded-xl border border-line-light object-cover" />
              </a>
              <p className="mt-2 text-xs text-ink-dark-muted">uploaded {formatDateOnly(member.idPhotoUploadedAt, tz)} · auto-deleted after 30 days · encrypted at rest</p>
            </>
          ) : (
            <p className="mt-2 text-ink-dark-muted">none</p>
          )}
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">Attendance</p>
          <p className="mt-1 text-ink-dark-muted">
            {member.attendanceStats?.shows ?? 0} shows · {member.attendanceStats?.noShows ?? 0} no-shows · {member.attendanceStats?.disputes ?? 0} disputes
          </p>
        </div>
        <div className="card p-5 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">Account</p>
          {member.bannedAt ? (
            <>
              <p className="mt-2"><Badge tone="red">banned</Badge> {formatDateOnly(member.bannedAt, tz)}</p>
              <p className="mt-1 text-ink-dark-muted">{member.banReason}</p>
              {staff.role === "ADMIN" && (
                <form action={unbanMemberAction} className="mt-3">
                  <input type="hidden" name="memberId" value={member.id} />
                  <button className="btn btn-outline !py-1 text-xs">Lift ban</button>
                </form>
              )}
            </>
          ) : staff.role === "ADMIN" ? (
            <form action={banMemberAction} className="mt-2 flex flex-col gap-2">
              <input type="hidden" name="memberId" value={member.id} />
              <input type="hidden" name="back" value={backPath} />
              <input name="reason" required minLength={3} placeholder="reason (required)" className="input !py-1 text-xs" />
              <button className="btn btn-outline !py-1 text-xs text-red">Ban member</button>
            </form>
          ) : (
            <p className="mt-2 text-ink-dark-muted">in good standing</p>
          )}
          {member.partnerClaimToken && <p className="mt-3 text-xs text-ink-dark-muted">partner token stored (Phase 7 verifies)</p>}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <WalletPools balance={balance} timezone={tz} />
        <div className="card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">Membership</p>
          <p className="mt-2 font-display text-2xl">
            {sub ? sub.plan.name : "none"}{" "}
            {sub && <Badge tone={statusTone(sub.status)}>{sub.status.toLowerCase().replace("_", " ")}</Badge>}
          </p>
          {sub && (
            <dl className="mt-3 space-y-1 text-sm text-ink-dark-muted">
              <div className="flex justify-between"><dt>Period</dt><dd>{formatDateOnly(sub.currentPeriodStart, tz)} → {formatDateOnly(sub.currentPeriodEnd, tz)}</dd></div>
              <div className="flex justify-between"><dt>Keys / month</dt><dd className="inline-flex items-center gap-1"><KeyIcon className="h-3.5 w-3.5 text-red" /> {membership.keysPerMonth}</dd></div>
              {sub.nextGrantAt && <div className="flex justify-between"><dt>Next grant</dt><dd>{formatDateOnly(sub.nextGrantAt, tz)}</dd></div>}
              {sub.cancelAtPeriodEnd && <div className="flex justify-between"><dt>Renewal</dt><dd className="text-red">cancelled at period end</dd></div>}
              {sub.firstPaidAt && <div className="flex justify-between"><dt>First paid</dt><dd>{formatDateOnly(sub.firstPaidAt, tz)}</dd></div>}
              <div className="flex justify-between"><dt>Stripe</dt><dd className="font-mono text-xs">{sub.stripeSubscriptionId ?? "—"}</dd></div>
            </dl>
          )}
        </div>
        {staff.role === "ADMIN" && (
          <form action={adjustKeysAction} className="card p-5 lg:col-span-3">
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

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <div>
          <SectionTitle>Fraud flags · {flags.length}</SectionTitle>
          <Table>
            <thead>
              <tr>
                <Th>Rule</Th>
                <Th>Evidence</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {flags.length === 0 && <EmptyRow colSpan={3}>No flags.</EmptyRow>}
              {flags.map((f) => (
                <tr key={f.id}>
                  <Td>
                    <Badge tone={f.status === "OPEN" ? "warn" : f.status === "APPROVED" ? "ok" : "red"}>{f.rule.toLowerCase().replace(/_/g, " ")}</Badge>
                    <div className="mt-1 text-xs text-ink-dark-muted">{formatDate(f.createdAt, tz)}</div>
                  </Td>
                  <Td><pre className="max-w-[14rem] whitespace-pre-wrap break-all font-mono text-[11px] text-ink-dark-muted">{JSON.stringify(f.evidence)}</pre></Td>
                  <Td>
                    {f.status === "OPEN" ? (
                      <form action={reviewFlagAction} className="flex gap-1">
                        <input type="hidden" name="flagId" value={f.id} />
                        <input type="hidden" name="back" value={backPath} />
                        <button name="decision" value="APPROVED" className="btn btn-outline !px-2 !py-1 text-xs">Approve</button>
                        <button name="decision" value="DENIED" className="btn btn-outline !px-2 !py-1 text-xs text-red">Deny</button>
                      </form>
                    ) : (
                      <span className="text-xs text-ink-dark-muted">{f.status.toLowerCase()} · {f.reviewedBy?.name ?? f.reviewedBy?.email}{f.reviewNote ? ` · ${f.reviewNote}` : ""}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
        <div>
          <SectionTitle>Devices · {devices.length}</SectionTitle>
          <Table>
            <thead>
              <tr>
                <Th>Fingerprint</Th>
                <Th>Last seen</Th>
                <Th>Shared with</Th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 && <EmptyRow colSpan={3}>No devices recorded yet.</EmptyRow>}
              {devices.map(({ device, sharedWith }) => (
                <tr key={device.id}>
                  <Td>
                    <span className="font-mono text-xs">{device.fingerprint.slice(0, 16)}…</span>
                    <div className="max-w-[12rem] truncate text-[11px] text-ink-dark-muted" title={device.userAgent ?? ""}>{device.userAgent}</div>
                  </Td>
                  <Td className="whitespace-nowrap text-ink-dark-muted">{formatDate(device.lastSeenAt, tz)}</Td>
                  <Td>
                    {sharedWith.length === 0 ? (
                      <span className="text-ink-dark-muted">nobody</span>
                    ) : (
                      <ul className="space-y-0.5 text-xs">
                        {sharedWith.map((o) => (
                          <li key={o.id}><Link href={`/admin/members/${o.id}`} className="hover:text-red">{o.email}</Link></li>
                        ))}
                      </ul>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
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
