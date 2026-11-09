import { cancelPartnerEvent, partnerRoute } from "@/domain/partners-api";

type Ctx = { params: Promise<{ eventosEventId: string }> };

/** Contract §3.4 — cancel: CANCELLED + keys refunded (cash refunds happen in EventOS). */
export async function POST(req: Request, { params }: Ctx) {
  const { eventosEventId } = await params;
  return partnerRoute(
    req,
    async (ctx, body) => {
      const reason = body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string" ? (body as { reason: string }).reason : null;
      return { status: 200, body: await cancelPartnerEvent(ctx.producer.id, eventosEventId, { reason }) };
    },
    { idempotent: true },
  );
}
