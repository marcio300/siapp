import { partnerRoute, pausePartnerEvent } from "@/domain/partners-api";

type Ctx = { params: Promise<{ eventosEventId: string }> };

/** Contract §3.4 — pause: hidden from members, no new redemptions, live ones untouched. */
export async function POST(req: Request, { params }: Ctx) {
  const { eventosEventId } = await params;
  return partnerRoute(req, async (ctx) => ({ status: 200, body: await pausePartnerEvent(ctx.producer.id, eventosEventId) }), { idempotent: true });
}
