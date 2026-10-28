import type { Balance } from "@/domain/keys";
import { formatDateOnly } from "@/lib/format";
import { KeyIcon } from "@/components/key-icon";

/** Wallet pools panel (docs/BRAND.md): headline total, plan keys with expiry, purchased keys. */
export function WalletPools({ balance, timezone = "Europe/Lisbon" }: { balance: Balance; timezone?: string }) {
  return (
    <div className="card p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-dark-muted">Wallet</p>
      <p className="mt-2 flex items-center gap-2 font-display text-4xl tabular-nums">
        <KeyIcon className="h-7 w-7 text-red" />
        {balance.total}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-ink-dark-muted">Plan keys</dt>
          <dd className="font-semibold tabular-nums">{balance.planKeys}</dd>
          <dd className="text-xs text-ink-dark-muted">
            {balance.planKeysExpireAt ? `expire ${formatDateOnly(balance.planKeysExpireAt, timezone)}` : "no active period"}
          </dd>
        </div>
        <div>
          <dt className="text-ink-dark-muted">Purchased keys</dt>
          <dd className="font-semibold tabular-nums">{balance.purchasedKeys}</dd>
          <dd className="text-xs text-ink-dark-muted">never expire</dd>
        </div>
      </dl>
    </div>
  );
}
