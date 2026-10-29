/**
 * Seeds the e2e database and provisions fixtures (run by e2e/global-setup.ts through tsx, which
 * resolves the `@/` path alias the way Next does). Writes e2e/.state.json.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { makePrismaClient } from "../src/lib/db";
import { runSeed } from "../prisma/seed-data";
import { createProducer } from "../src/domain/producers";
import { addOffer, createEvent, setEventStatus } from "../src/domain/events";

(async () => {
  const dbUrl = process.env.DATABASE_URL!;
  const db = makePrismaClient();
  try {
    const seed = await runSeed(db, { adminEmail: "admin@e2e.siapp" });
    // A fresh account redeems three times inside its first hour: lift the velocity rule for the run.
    await db.setting.update({ where: { key: "velocity_first_hour_max" }, data: { value: 10 } });
    const run = Date.now().toString(36);
    const producer = await createProducer({ name: `E2E Club ${run}`, cityId: seed.cityId }, { db });
    const HOUR = 3_600_000;
    const local = (d: Date) => ({ date: d.toISOString().slice(0, 10), time: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` });
    const mk = async (title: string, hoursAhead: number) => {
      const start = new Date(Date.now() + hoursAhead * HOUR);
      const { event, pin } = await createEvent({ producerId: producer.id, title, venue: "E2E Venue", imageUrls: "", tags: "e2e", startsAt: local(start), endsAt: local(new Date(start.getTime() + 5 * HOUR)) }, { db });
      await addOffer(event.id, { name: "Free entry", type: "FREE_TICKET", keyCost: 5, allocationType: "CAPPED", capacity: 50, openToFree: true }, { db });
      await setEventStatus(event.id, "PUBLISHED", { db });
      const fresh = await db.event.findUniqueOrThrow({ where: { id: event.id } });
      return { id: event.id, title, scannerCode: fresh.scannerCode, pin };
    };
    const state = { dbUrl, friday: await mk(`E2E Friday ${run}`, 72), nextWeek: await mk(`E2E Next week ${run}`, 100), tonight: await mk(`E2E Tonight ${run}`, 10) };
    writeFileSync(path.join(process.cwd(), "e2e/.state.json"), JSON.stringify(state, null, 2));
    console.log("[e2e] fixtures ready");
  } finally {
    await db.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
