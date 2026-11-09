import { applySnapshot, partnerRoute } from "@/domain/partners-api";

type Ctx = { params: Promise<{ eventosEventId: string }> };

/** Contract §3.3 — upsert the event snapshot + offers (one transaction, 422 applies nothing). */
export async function PUT(req: Request, { params }: Ctx) {
  const { eventosEventId } = await params;
  return partnerRoute(req, async (ctx, body) => ({ status: 200, body: await applySnapshot(ctx.producer, eventosEventId, body) }), { idempotent: true });
}
