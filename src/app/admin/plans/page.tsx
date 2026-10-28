import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { formatMoney } from "@/lib/format";
import { Badge } from "@/components/backoffice/badge";
import { PageHeader, SectionTitle } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { KeyIcon } from "@/components/key-icon";
import { syncStripePricesAction, updateKeyPackAction, updatePlanPriceAction, updateTierAction } from "./actions";

/**
 * Plans & key packs: ADMIN edits amounts inline, then pushes them to Stripe.
 * Edits only affect NEW purchases — existing Stripe subscriptions keep their
 * price until they're moved (Stripe prices are immutable).
 */
export default async function PlansPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const staff = await requireStaffPage("OPS");
  const sp = await searchParams;
  const canEdit = staff.role === "ADMIN";
  const [tiers, plans, packs] = await Promise.all([
    prisma.tier.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.plan.findMany({
      include: { tier: true, prices: { include: { city: true } } },
      orderBy: [{ tier: { sortOrder: "asc" } }, { period: "asc" }],
    }),
    prisma.keyPack.findMany({ orderBy: { sortOrder: "asc" } }),
  ]);

  return (
    <>
      <PageHeader
        title="Plans & key packs"
        subtitle="Config lives in the database. Edits apply to new purchases only — then sync so Stripe has the matching prices."
        actions={
          canEdit && (
            <form action={syncStripePricesAction}>
              <button className="btn btn-primary">Sync to Stripe</button>
            </form>
          )
        }
      />
      {sp.error && <p className="mb-4 rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{sp.error}</p>}
      {sp.saved && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Saved. Run “Sync to Stripe” when you&apos;re done editing.</p>}
      {sp.synced && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Stripe synced: {sp.synced}</p>}

      <SectionTitle>Tiers</SectionTitle>
      <Table className="mb-8">
        <thead>
          <tr>
            <Th>Tier</Th>
            <Th align="right">Keys / month</Th>
            <Th>Private sale</Th>
            <Th>+1 by default</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((t) => (
            <tr key={t.id}>
              <Td className="font-medium">{t.name}</Td>
              <Td align="right">
                {canEdit ? (
                  <form action={updateTierAction} className="inline-flex items-center justify-end gap-2">
                    <input type="hidden" name="tierId" value={t.id} />
                    <KeyIcon />
                    <input name="keysPerMonth" type="number" min={0} step={1} defaultValue={t.keysPerMonth} className="input w-24 !py-1 text-right" />
                    <button className="btn btn-outline !py-1">Save</button>
                  </form>
                ) : (
                  <span className="inline-flex items-center gap-1"><KeyIcon /> {t.keysPerMonth}</span>
                )}
              </Td>
              <Td>{t.privateSaleByDefault ? "yes" : "—"}</Td>
              <Td>{t.plusOneByDefault ? "yes" : "—"}</Td>
              <Td><Badge tone={t.isActive ? "ok" : "neutral"}>{t.isActive ? "active" : "inactive"}</Badge></Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <SectionTitle>Plans</SectionTitle>
      <Table className="mb-8">
        <thead>
          <tr>
            <Th>Plan</Th>
            <Th>Period</Th>
            <Th>Price</Th>
            <Th align="right">Keys / period</Th>
            <Th>Stripe</Th>
          </tr>
        </thead>
        <tbody>
          {plans.length === 0 && <EmptyRow colSpan={5}>No plans yet — run `pnpm db:seed`.</EmptyRow>}
          {plans.map((p) =>
            p.prices.map((pr) => {
              const free = pr.amountCents === 0;
              return (
                <tr key={pr.id}>
                  <Td className="font-medium">{p.name}</Td>
                  <Td>{p.period}</Td>
                  <Td>
                    {canEdit && !free ? (
                      <form action={updatePlanPriceAction} className="inline-flex items-center gap-2">
                        <input type="hidden" name="planPriceId" value={pr.id} />
                        <span className="text-ink-dark-muted">€</span>
                        <input name="amountEuros" type="number" min={0} step="0.01" defaultValue={(pr.amountCents / 100).toFixed(2)} className="input w-24 !py-1" />
                        {p.period === "TOURIST_WEEK" && (
                          <>
                            <KeyIcon />
                            <input name="keysPerPeriod" type="number" min={0} step={1} defaultValue={p.keysPerPeriod ?? p.tier.keysPerMonth} className="input w-20 !py-1" />
                          </>
                        )}
                        <button className="btn btn-outline !py-1">Save</button>
                        <span className="text-xs text-ink-dark-muted">{pr.city.name}</span>
                      </form>
                    ) : (
                      <>
                        {formatMoney(pr.amountCents, pr.currency)} <span className="text-ink-dark-muted">{pr.city.name}</span>
                      </>
                    )}
                  </Td>
                  <Td align="right">
                    <span className="inline-flex items-center gap-1"><KeyIcon /> {p.keysPerPeriod ?? p.tier.keysPerMonth}</span>
                  </Td>
                  <Td>
                    {free ? <Badge>free</Badge> : pr.stripePriceId ? <Badge tone="ok">synced</Badge> : <Badge tone="warn">not synced</Badge>}
                  </Td>
                </tr>
              );
            }),
          )}
        </tbody>
      </Table>

      <SectionTitle>Key packs</SectionTitle>
      <Table>
        <thead>
          <tr>
            <Th>Pack</Th>
            <Th align="right">Keys</Th>
            <Th>Price</Th>
            <Th>Per key</Th>
            <Th>Stripe</Th>
          </tr>
        </thead>
        <tbody>
          {packs.length === 0 && <EmptyRow colSpan={5}>No key packs yet — run `pnpm db:seed`.</EmptyRow>}
          {packs.map((k) =>
            canEdit ? (
              <tr key={k.id}>
                <Td className="font-medium" colSpan={3}>
                  <form action={updateKeyPackAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="keyPackId" value={k.id} />
                    <span className="mr-2">{k.name}</span>
                    <KeyIcon />
                    <input name="keys" type="number" min={1} step={1} defaultValue={k.keys} className="input w-20 !py-1" />
                    <span className="text-ink-dark-muted">€</span>
                    <input name="amountEuros" type="number" min={0} step="0.01" defaultValue={(k.amountCents / 100).toFixed(2)} className="input w-24 !py-1" />
                    <label className="flex items-center gap-1 text-xs text-ink-dark-muted">
                      <input type="checkbox" name="isActive" defaultChecked={k.isActive} /> on sale
                    </label>
                    <button className="btn btn-outline !py-1">Save</button>
                  </form>
                </Td>
                <Td className="text-ink-dark-muted">{formatMoney(Math.round(k.amountCents / k.keys), k.currency)}</Td>
                <Td>{k.stripePriceId ? <Badge tone="ok">synced</Badge> : <Badge tone="warn">not synced</Badge>}</Td>
              </tr>
            ) : (
              <tr key={k.id}>
                <Td className="font-medium">{k.name}</Td>
                <Td align="right"><span className="inline-flex items-center gap-1"><KeyIcon /> {k.keys}</span></Td>
                <Td>{formatMoney(k.amountCents, k.currency)}</Td>
                <Td className="text-ink-dark-muted">{formatMoney(Math.round(k.amountCents / k.keys), k.currency)}</Td>
                <Td>{k.stripePriceId ? <Badge tone="ok">synced</Badge> : <Badge tone="warn">not synced</Badge>}</Td>
              </tr>
            ),
          )}
        </tbody>
      </Table>
    </>
  );
}
