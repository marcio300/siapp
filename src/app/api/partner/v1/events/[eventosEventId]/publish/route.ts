import { partnerRoute, publishPartnerEvent } from "@/domain/partners-api";

type Ctx = { params: Promise<{ eventosEventId: string }> };

/** Contract §3.4 — publish (clears a pause). */
export async function POST(req: Request, { params }: Ctx) {
  const { eventosEventId } = await params;
  return partnerRoute(req, async (ctx) => ({ status: 200, body: await publishPartnerEvent(ctx.producer.id, eventosEventId) }), { idempotent: true });
}
