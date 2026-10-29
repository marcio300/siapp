import { NextResponse } from "next/server";
import { cronAuthorized, isCronJobName, runCronJob } from "@/lib/cron-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Vercel Cron entry point: `GET /api/cron/<job>` with `Authorization: Bearer ${CRON_SECRET}`
 * (Vercel sends it automatically when CRON_SECRET is set on the project). Schedules live in
 * vercel.json; the job list in src/lib/cron-jobs.ts.
 */
export async function GET(req: Request, ctx: { params: Promise<{ job: string }> }) {
  if (!cronAuthorized(req)) return new NextResponse("Unauthorized", { status: 401 });
  const { job } = await ctx.params;
  if (!isCronJobName(job)) return NextResponse.json({ error: `Unknown job ${job}` }, { status: 404 });
  try {
    const out = await runCronJob(job);
    console.log(`[cron] ${job} ${out.ms} ms ${JSON.stringify(out.result)}`);
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    console.error(`[cron] ${job} failed:`, e);
    return NextResponse.json({ ok: false, job, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
