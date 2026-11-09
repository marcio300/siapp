import { completeExternalPayment, partnerRoute } from "@/domain/partners-api";

type Ctx = { params: Promise<{ redemptionId: string }> };

/** Contract §3.8 — the producer's EventOS reports `order.paid` / `order.expired` / `refund.*` for a producer-collects redemption. */
export async function POST(req: Request, { params }: Ctx) {
  const { redemptionId } = await params;
  return partnerRoute(req, async (ctx, body) => ({ status: 200, body: await completeExternalPayment(ctx.producer.id, redemptionId, body) }), { idempotent: true });
}
