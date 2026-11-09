import { connectProducer, partnerRoute } from "@/domain/partners-api";

/** Contract §3.1 — bind the producer to an EventOS org and rotate the webhook secret. */
export async function POST(req: Request) {
  return partnerRoute(req, async (ctx, body) => ({ status: 200, body: await connectProducer(ctx.producer, body) }), { idempotent: true });
}
