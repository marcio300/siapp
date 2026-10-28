/**
 * Runtime guards for the "dev" stand-ins (console email today; more later).
 * They exist so the whole flow runs before real provider keys exist — and
 * must never be what a real member hits. Production is detected by Vercel's
 * VERCEL_ENV ("production" only: previews, local dev and tests keep the
 * stand-ins).
 */
export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_ENV === "production";
}

/** Throws when a dev stand-in would be used in production. */
export function assertDevStandInAllowed(what: string, hint: string): void {
  if (isProductionRuntime()) {
    throw new Error(`${what} is disabled in production — ${hint}`);
  }
}
