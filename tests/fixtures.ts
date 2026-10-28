import { randomUUID } from "node:crypto";
import { prisma } from "./db";

let n = 0;
const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

export async function createCity() {
  return prisma.city.upsert({
    where: { country_name: { country: "PT", name: "Lisbon" } },
    update: {},
    create: { name: "Lisbon", country: "PT", timezone: "Europe/Lisbon", currency: "EUR" },
  });
}

export async function createMember(email = `m-${uid()}@test.siapp`) {
  const city = await createCity();
  return prisma.member.create({
    data: { email, cityId: city.id, referralCode: uid().toUpperCase().padEnd(8, "X").slice(0, 8) + uid().slice(-2) },
  });
}

export async function createStaff(role: "ADMIN" | "OPS" | "DOOR" = "ADMIN") {
  const email = `staff-${uid()}@test.siapp`;
  const staff = await prisma.staffUser.create({ data: { email, role } });
  await createMember(email);
  return staff;
}

/** Minimal producer → event → offer → redemption chain so ledger rows can reference a redemption. */
export async function createRedemption(memberId: string, keyCost = 10) {
  const city = await createCity();
  const producer = await prisma.producer.create({ data: { cityId: city.id, name: `Producer ${uid()}` } });
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  const event = await prisma.event.create({
    data: {
      producerId: producer.id,
      cityId: city.id,
      title: `Event ${uid()}`,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 6 * 3_600_000),
      status: "PUBLISHED",
      scannerCode: uid(),
      scannerPinHash: "x",
    },
  });
  const offer = await prisma.offer.create({
    data: { eventId: event.id, name: "Standard", type: "FREE_TICKET", keyCost, allocationType: "CAPPED", capacity: 100 },
  });
  return prisma.redemption.create({
    data: {
      memberId,
      offerId: offer.id,
      eventId: event.id,
      status: "ACTIVE",
      keyCost,
      cancelDeadlineAt: new Date(startsAt.getTime() - 24 * 3_600_000),
      stripePaymentIntentId: null,
      id: randomUUID(),
    },
  });
}
