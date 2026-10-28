import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { formatMoney } from "@/lib/format";
import { Badge } from "@/components/backoffice/badge";
import { PageHeader, SectionTitle } from "@/components/backoffice/page-header";
import { EmptyRow, Table, Td, Th } from "@/components/backoffice/table";
import { KeyIcon } from "@/components/key-icon";

/** Read-only in Phase 0; editing + Stripe sync button land in Phase 2. */
export default async function PlansPage() {
  await requireStaffPage("OPS");
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
        subtitle="Tier config and prices live in the database. Run `pnpm stripe:sync-prices` after editing amounts."
      />

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
                <span className="inline-flex items-center gap-1"><KeyIcon /> {t.keysPerMonth}</span>
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
          {plans.map((p) => (
            <tr key={p.id}>
              <Td className="font-medium">{p.name}</Td>
              <Td>{p.period}</Td>
              <Td>
                {p.prices.length === 0
                  ? "—"
                  : p.prices.map((pr) => (
                      <span key={pr.id} className="mr-3 inline-block">
                        {formatMoney(pr.amountCents, pr.currency)} <span className="text-ink-dark-muted">{pr.city.name}</span>
                      </span>
                    ))}
              </Td>
              <Td align="right">
                <span className="inline-flex items-center gap-1"><KeyIcon /> {p.keysPerPeriod ?? p.tier.keysPerMonth}</span>
              </Td>
              <Td>
                {p.prices.every((pr) => pr.amountCents === 0) ? (
                  <Badge>free</Badge>
                ) : p.prices.every((pr) => pr.stripePriceId) ? (
                  <Badge tone="ok">synced</Badge>
                ) : (
                  <Badge tone="warn">not synced</Badge>
                )}
              </Td>
            </tr>
          ))}
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
          {packs.map((k) => (
            <tr key={k.id}>
              <Td className="font-medium">{k.name}</Td>
              <Td align="right"><span className="inline-flex items-center gap-1"><KeyIcon /> {k.keys}</span></Td>
              <Td>{formatMoney(k.amountCents, k.currency)}</Td>
              <Td className="text-ink-dark-muted">{formatMoney(Math.round(k.amountCents / k.keys), k.currency)}</Td>
              <Td>{k.stripePriceId ? <Badge tone="ok">synced</Badge> : <Badge tone="warn">not synced</Badge>}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
