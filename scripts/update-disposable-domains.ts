/**
 * Refresh src/domain/fraud/disposable-domains.json from the upstream
 * community list. Run occasionally; commit the result.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE =
  "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf";

(async () => {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const text = await res.text();
  const domains = [...new Set(text.split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#")))].sort();
  writeFileSync(join(__dirname, "..", "src", "domain", "fraud", "disposable-domains.json"), JSON.stringify(domains) + "\n");
  console.log(`[disposable-domains] ${domains.length} domains written`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
