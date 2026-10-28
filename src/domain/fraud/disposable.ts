import domains from "./disposable-domains.json";

/**
 * Disposable-email blocklist (CLAUDE.md rule 7). The list is the community
 * maintained disposable-email-domains project, vendored as JSON; refresh it
 * with `pnpm exec tsx scripts/update-disposable-domains.ts`. Matching covers
 * subdomains (a.mailinator.com) so a blocked apex can't be dodged.
 */
const BLOCKED = new Set<string>(domains as string[]);

export const DISPOSABLE_DOMAIN_COUNT = BLOCKED.size;

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

export function isDisposableDomain(domain: string): boolean {
  const parts = domain.toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (BLOCKED.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

export function isDisposableEmail(email: string): boolean {
  const domain = emailDomain(email);
  return domain ? isDisposableDomain(domain) : false;
}
