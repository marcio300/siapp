import { findPartnerEvent, offerCountersByStatus, partnerRoute, salesForEvent, toOfferResult } from "@/domain/partners-api";
import { prisma } from "@/lib/db";

type Ctx = { params: Promise<{ eventosEventId: string }> };

/** Contract §3.5 — offers with counters + redemptions since/cursor. */
export async function GET(req: Request, { params }: Ctx) {
  const { eventosEventId } = await params;
  return partnerRoute(req, async (ctx) => {
    const url = new URL(req.url);
    const event = await findPartnerEvent(ctx.producer.id, eventosEventId);
    const offers = await prisma.offer.findMany({ where: { eventId: event.id }, orderBy: { sortOrder: "asc" } });
    const counters = await offerCountersByStatus(prisma, offers.map((o) => o.id));
    const page = await salesForEvent(event.id, { since: url.searchParams.get("since"), cursor: url.searchParams.get("cursor"), limit: Number(url.searchParams.get("limit") ?? 200) || 200 });
    return {
      status: 200,
      body: {
        siappEventId: event.id,
        status: event.status,
        pausedAt: event.pausedAt?.toISOString() ?? null,
        offers: offers.map((o) => toOfferResult(o, counters.get(o.id)!, 0)),
        redemptions: page.redemptions,
        nextCursor: page.nextCursor,
        updatedAt: new Date().toISOString(),
      },
    };
  });
}
