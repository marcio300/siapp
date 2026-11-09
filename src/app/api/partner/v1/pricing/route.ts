import { loadLimits, loadPricing, partnerRoute } from "@/domain/partners-api";

/** Contract §3.2 — the current pricing rule + limits. */
export async function GET(req: Request) {
  return partnerRoute(req, async () => ({ status: 200, body: { pricing: await loadPricing(), limits: await loadLimits() } }));
}
