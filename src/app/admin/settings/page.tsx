import { prisma } from "@/lib/db";
import { requireStaffPage } from "@/lib/authz";
import { SETTING_DEFAULTS, SETTING_DESCRIPTIONS, type SettingKey } from "@/lib/settings";
import { PageHeader } from "@/components/backoffice/page-header";
import { Table, Td, Th } from "@/components/backoffice/table";
import { Badge } from "@/components/backoffice/badge";
import { getSetting } from "@/lib/settings";
import { setPublicSignInAction } from "./actions";

/** Numeric settings are read-only here (editing lands with the phase that first needs it); the launch switch is live. ADMIN only. */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ launch?: string }> }) {
  await requireStaffPage("ADMIN");
  const { launch } = await searchParams;
  const rows = await prisma.setting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const open = (await getSetting("public_signin_open")) === 1;

  return (
    <>
      <PageHeader title="Settings" subtitle="Global defaults. Per-offer overrides (e.g. cancellation window) win over these." />
      {launch && <p className="mb-4 rounded-lg border border-ok/40 bg-ok/15 px-4 py-2 text-sm">Public sign-in {launch}.</p>}
      <div className="card mb-6 flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">Launch switch</p>
          <p className="mt-2 text-sm">
            {open ? <Badge tone="ok">public sign-in open</Badge> : <Badge tone="warn">closed — invite-only</Badge>}
          </p>
          <p className="mt-2 max-w-xl text-xs text-ink-dark-muted">
            {open
              ? "Anyone can sign in at /sign-in and create an account. Close it to go back to invite-only."
              : "Nobody can create an account. Only staff (via /staff/sign-in), existing members and founders you have invited from the Founders page can sign in. Open it on launch day."}
          </p>
        </div>
        <form action={setPublicSignInAction}>
          <input type="hidden" name="open" value={open ? "0" : "1"} />
          <button className={`btn ${open ? "btn-outline" : "btn-primary"}`}>{open ? "Close public sign-in" : "Open public sign-in"}</button>
        </form>
      </div>
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
