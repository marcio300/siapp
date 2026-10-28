"use server";

import { redirect } from "next/navigation";
import type { EventStatus } from "@prisma/client";
import { requireStaff } from "@/lib/authz";
import { checkbox, localDateTime, multi, text } from "@/lib/forms";
import {
  EventError,
  addOffer,
  createEvent,
  deleteOffer,
  duplicateEvent,
  regenerateScannerPin,
  setEventStatus,
  updateEvent,
  updateOffer,
  type EventInput,
  type OfferInput,
} from "@/domain/events";
import { refundEventRedemptions } from "@/domain/redemption/lifecycle";

function eventInput(fd: FormData): EventInput {
  return {
    producerId: text(fd, "producerId") ?? "",
    title: text(fd, "title") ?? "",
    description: text(fd, "description"),
    venue: text(fd, "venue"),
    address: text(fd, "address"),
    imageUrls: text(fd, "imageUrls"),
    tags: text(fd, "tags"),
    startsAt: localDateTime(fd, "startsAt") as { date: string; time: string },
    endsAt: localDateTime(fd, "endsAt") as { date: string; time: string },
  };
}

function offerInput(fd: FormData): OfferInput {
  return {
    name: text(fd, "name") ?? "",
    type: text(fd, "type") as OfferInput["type"],
    keyCost: text(fd, "keyCost") ?? "0",
    faceValueEuros: text(fd, "faceValueEuros"),
    discountPercent: text(fd, "discountPercent"),
    allocationType: text(fd, "allocationType") as OfferInput["allocationType"],
    capacity: text(fd, "capacity"),
    validUntilLocal: text(fd, "validUntilLocal"),
    afterWindowBehaviour: (text(fd, "afterWindowBehaviour") || undefined) as OfferInput["afterWindowBehaviour"],
    privateSaleTiers: multi(fd, "privateSaleTiers") as OfferInput["privateSaleTiers"],
    privateSaleHoursBefore: text(fd, "privateSaleHoursBefore"),
    privateSaleOpensAt: localDateTime(fd, "privateSaleOpensAt"),
    openToFree: checkbox(fd, "openToFree"),
    plusOneAllowed: checkbox(fd, "plusOneAllowed"),
    plusOneExtraKeyCost: text(fd, "plusOneExtraKeyCost"),
    plusOneExtraCashEuros: text(fd, "plusOneExtraCashEuros"),
    cancellationWindowHours: text(fd, "cancellationWindowHours"),
    maxPerMember: text(fd, "maxPerMember"),
    redeemFrom: localDateTime(fd, "redeemFrom"),
    redeemUntil: localDateTime(fd, "redeemUntil"),
    sortOrder: text(fd, "sortOrder"),
  };
}

/** Query before hash: `/admin/events/x?error=…#offers`. */
function fail(e: unknown, path: string): never {
  if (e instanceof EventError) {
    const [base, hash] = path.split("#");
    redirect(`${base}?error=${encodeURIComponent(e.message)}${hash ? `#${hash}` : ""}`);
  }
  throw e;
}

export async function createEventAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  let result;
  try {
    result = await createEvent(eventInput(fd));
  } catch (e) {
    fail(e, "/admin/events/new");
  }
  redirect(`/admin/events/${result.event.id}?created=1&pin=${result.pin}`);
}

export async function updateEventAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  const id = text(fd, "id") ?? "";
  try {
    await updateEvent(id, eventInput(fd));
  } catch (e) {
    fail(e, `/admin/events/${id}`);
  }
  redirect(`/admin/events/${id}?saved=1`);
}

export async function setEventStatusAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  const id = text(fd, "id") ?? "";
  const status = text(fd, "status") as EventStatus;
  try {
    await setEventStatus(id, status);
  } catch (e) {
    fail(e, `/admin/events/${id}`);
  }
  // Cancelling an event refunds every live redemption (keys + cash) and closes its waitlists.
  if (status === "CANCELLED") await refundEventRedemptions(id);
  redirect(`/admin/events/${id}?status=${status.toLowerCase()}`);
}

export async function duplicateEventAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  const id = text(fd, "id") ?? "";
  const shiftDays = Number(text(fd, "shiftDays") ?? "0") || 0;
  let result;
  try {
    result = await duplicateEvent(id, { shiftDays });
  } catch (e) {
    fail(e, `/admin/events/${id}`);
  }
  redirect(`/admin/events/${result.event.id}?created=1&pin=${result.pin}`);
}

export async function regeneratePinAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  const id = text(fd, "id") ?? "";
  const pin = await regenerateScannerPin(id);
  redirect(`/admin/events/${id}?pin=${pin}`);
}

export async function addOfferAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  const eventId = text(fd, "eventId") ?? "";
  try {
    await addOffer(eventId, offerInput(fd));
  } catch (e) {
    fail(e, `/admin/events/${eventId}#offers`);
  }
  redirect(`/admin/events/${eventId}?offer=added#offers`);
}

export async function updateOfferAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  const eventId = text(fd, "eventId") ?? "";
  const offerId = text(fd, "offerId") ?? "";
  try {
    await updateOffer(offerId, offerInput(fd));
  } catch (e) {
    fail(e, `/admin/events/${eventId}#offers`);
  }
  redirect(`/admin/events/${eventId}?offer=saved#offers`);
}

export async function deleteOfferAction(fd: FormData): Promise<void> {
  await requireStaff("OPS");
  const eventId = text(fd, "eventId") ?? "";
  const offerId = text(fd, "offerId") ?? "";
  try {
    await deleteOffer(offerId);
  } catch (e) {
    fail(e, `/admin/events/${eventId}#offers`);
  }
  redirect(`/admin/events/${eventId}?offer=deleted#offers`);
}
