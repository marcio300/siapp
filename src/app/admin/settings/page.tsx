import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { SETTING_DEFAULTS, SETTING_DESCRIPTIONS, type SettingKey } from "@/lib/settings";
import { PageHeader } from "@/components/backoffice/page-header";
import { Table, Td, Th } from "@/components/backoffice/table";
import { Badge } from "@/components/backoffice/badge";

/** Read-only in Phase 0 (ADMIN only); editing lands with the phase that first needs it. */
export default async function SettingsPage() {
  await requireStaffPage("ADMIN");
  const rows = await prisma.setting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));

  return (
    <>
      <PageHeader title="Settings" subtitle="Global defaults. Per-offer overrides (e.g. cancellation window) win over these." />
      <Table>
        <thead>
          <tr>
            <Th>Key</Th>
            <Th align="right">Value</Th>
            <Th>Default</Th>
            <Th>What it does</Th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(SETTING_DEFAULTS) as SettingKey[]).map((key) => {
            const row = byKey.get(key);
            return (
              <tr key={key}>
                <Td className="font-mono text-xs">{key}</Td>
                <Td align="right" className="font-medium">
                  {row ? String(row.value) : <Badge tone="warn">unset</Badge>}
                </Td>
                <Td className="text-ink-dark-muted">{String(SETTING_DEFAULTS[key])}</Td>
                <Td className="text-ink-dark-muted">{SETTING_DESCRIPTIONS[key]}</Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
