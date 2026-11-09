/**
 * Keep an embedded Postgres alive for the SIAPP ↔ EventOS end-to-end run.
 * Usage: pnpm exec tsx scripts/e2e-eventos/pg-keep.ts [port] [dataDir]
 * (dev-local hardcodes 5433, which the EventOS side uses — so the e2e run
 * gives SIAPP its own port.) Stop with SIGTERM/SIGINT.
 */
import path from "node:path";
import { ROOT, startEmbedded } from "../embedded-pg";

const port = Number(process.argv[2] ?? 5436);
const dataDir = path.resolve(process.argv[3] ?? path.join(ROOT, ".devdb"));
const log = (m: string) => console.log(`[pg-keep] ${m}`);

async function main() {
  const instance = await startEmbedded({ dataDir, port, log });
  log(`ready on ${port} (data ${dataDir})`);
  const stop = async () => {
    if (instance) await instance.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  setInterval(() => undefined, 1 << 30);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
