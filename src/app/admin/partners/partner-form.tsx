import type { PartnerCommunity } from "@prisma/client";

const EXAMPLES = ['{"kind":"PLAN_PERIOD","tier":"SOCIAL","months":3}', '{"kind":"KEYS","keys":20}', '{"kind":"STRIPE_COUPON","couponId":"ELL20"}'];

export function PartnerForm({ community, action, submitLabel, readOnly = false }: { community?: PartnerCommunity; action: (fd: FormData) => Promise<void>; submitLabel: string; readOnly?: boolean }) {
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      {community && <input type="hidden" name="id" value={community.id} />}
      <label className="flex flex-col gap-1">
        <span className="label">Code (the token&apos;s <span className="font-mono">source</span>)</span>
        <input name="code" required minLength={2} maxLength={16} defaultValue={community?.code ?? ""} readOnly={readOnly} className="input font-mono uppercase" placeholder="ELL" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Name</span>
        <input name="name" required minLength={2} maxLength={80} defaultValue={community?.name ?? ""} readOnly={readOnly} className="input" placeholder="Erasmus Life Lisboa" />
      </label>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="label">Public key (RSA, PEM) — verifies the partner&apos;s RS256 tokens</span>
        <textarea name="publicKey" required rows={6} defaultValue={community?.publicKey ?? ""} readOnly={readOnly} className="input font-mono text-xs" placeholder={"-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"} />
      </label>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="label">Promo (JSON) — what a successful claim grants</span>
        <input name="promo" required defaultValue={community ? JSON.stringify(community.promo) : EXAMPLES[0]} readOnly={readOnly} className="input font-mono text-xs" />
        <span className="text-xs text-ink-dark-muted">{EXAMPLES.join("  ·  ")}</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isActive" defaultChecked={community?.isActive ?? true} disabled={readOnly} />
        Accepting claims
      </label>
      {!readOnly && (
        <div className="flex items-end justify-end">
          <button className="btn btn-primary">{submitLabel}</button>
        </div>
      )}
    </form>
  );
}
