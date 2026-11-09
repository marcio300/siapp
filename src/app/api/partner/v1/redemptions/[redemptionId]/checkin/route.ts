import { partnerRoute, recordExternalCheckIn } from "@/domain/partners-api";

type Ctx = { params: Promise<{ redemptionId: string }> };

/** Contract §3.7 — the producer's EventOS scanner admitted a SIAPP ticket. Idempotent by `eventosCheckInId`. */
export async function POST(req: Request, { params }: Ctx) {
  const { redemptionId } = await params;
  return partnerRoute(req, async (ctx, body) => ({ status: 200, body: await recordExternalCheckIn(ctx.producer.id, redemptionId, body) }), { idempotent: true });
}
