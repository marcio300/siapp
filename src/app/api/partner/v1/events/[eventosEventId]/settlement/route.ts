import { PartnerApiError, findPartnerEvent, partnerRoute } from "@/domain/partners-api";

type Ctx = { params: Promise<{ eventosEventId: string }> };

/** Contract §3.6 — EventOS producers collect their own money: nothing to settle (404 no_settlement). */
export async function GET(req: Request, { params }: Ctx) {
  const { eventosEventId } = await params;
  return partnerRoute(req, async (ctx) => {
    await findPartnerEvent(ctx.producer.id, eventosEventId);
    throw new PartnerApiError(404, "no_settlement", "Nothing to settle — you collect payments directly");
  });
}
