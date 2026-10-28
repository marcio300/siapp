import { z } from "zod";

/**
 * Zod schemas for events and offers (spec §6), shared by the server actions
 * and the forms (field constraints, option lists). Local date/time fields are
 * wall-clock values in the event city's timezone; the domain converts to UTC.
 */
export const TIER_CODES = ["FREE", "SOCIAL", "REGULAR", "PLUS"] as const;
export const OFFER_TYPES = ["FREE_TICKET", "DISCOUNT_TICKET", "GUESTLIST"] as const;
export const ALLOCATION_TYPES = ["CAPPED", "TIME_WINDOW"] as const;
export const AFTER_WINDOW = ["REFUSE", "PAY_DOOR"] as const;
export const PRIVATE_SALE_HOURS = [24, 48] as const;

/** "" / null / undefined → undefined, so optional number inputs don't coerce to 0 (EventOS gotcha). */
export const optionalInt = (min = 0, max = 1_000_000) =>
  z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : v), z.coerce.number().int().min(min).max(max).optional());

export const optionalMoneyEuros = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : v),
  z.coerce.number().min(0).max(100_000).optional(),
);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date");
const localTime = z.string().regex(/^\d{2}:\d{2}$/, "Enter a time like 23:00");
const optionalLocalDateTime = z
  .object({ date: z.string().optional(), time: z.string().optional() })
  .transform((v) => (v.date && v.time ? { date: v.date, time: v.time } : undefined))
  .refine((v) => !v || (/^\d{4}-\d{2}-\d{2}$/.test(v.date) && /^\d{2}:\d{2}$/.test(v.time)), "Enter a date and a time");

export const EventSchema = z
  .object({
    producerId: z.string().min(1, "Pick a producer"),
    title: z.string().trim().min(2, "Title is required").max(140),
    description: optionalText(5000),
    venue: optionalText(140),
    address: optionalText(240),
    /** One URL per line. */
    imageUrls: z
      .string()
      .optional()
      .transform((v) => (v ?? "").split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean))
      .refine((urls) => urls.every((u) => /^https?:\/\//.test(u)), "Image URLs must start with http(s)://")
      .refine((urls) => urls.length <= 10, "At most 10 images"),
    /** Comma-separated. */
    tags: z
      .string()
      .optional()
      .transform((v) => [...new Set((v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 20)),
    startsAt: z.object({ date: localDate, time: localTime }),
    endsAt: z.object({ date: localDate, time: localTime }),
  })
  .refine((e) => e.startsAt.date <= e.endsAt.date, { message: "The event must end after it starts", path: ["endsAt"] });

export type EventInput = z.input<typeof EventSchema>;

export const OfferSchema = z
  .object({
    name: z.string().trim().min(1, "Offer name is required").max(80),
    type: z.enum(OFFER_TYPES),
    keyCost: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(0, "Key cost can't be negative").max(100_000)),
    faceValueEuros: optionalMoneyEuros,
    discountPercent: optionalInt(0, 100),
    allocationType: z.enum(ALLOCATION_TYPES),
    capacity: optionalInt(1),
    /** TIME_WINDOW: local wall-clock time like "02:00" — the next occurrence after the event starts. */
    validUntilLocal: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined))
      .refine((v) => !v || /^\d{2}:\d{2}$/.test(v), "Enter a time like 02:00"),
    afterWindowBehaviour: z.enum(AFTER_WINDOW).optional(),
    privateSaleTiers: z.array(z.enum(TIER_CODES)).default([]),
    privateSaleHoursBefore: optionalInt(1, 168),
    /** Explicit override of the computed opens-at (local date/time). */
    privateSaleOpensAt: optionalLocalDateTime.optional(),
    openToFree: z.boolean().default(false),
    plusOneAllowed: z.boolean().default(false),
    plusOneExtraKeyCost: optionalInt(0),
    plusOneExtraCashEuros: optionalMoneyEuros,
    cancellationWindowHours: optionalInt(0, 720),
    maxPerMember: optionalInt(1, 100),
    redeemFrom: optionalLocalDateTime.optional(),
    redeemUntil: optionalLocalDateTime.optional(),
    sortOrder: optionalInt(0, 1000),
  })
  .superRefine((o, ctx) => {
    if (o.type === "DISCOUNT_TICKET") {
      if (!o.faceValueEuros || o.faceValueEuros <= 0) ctx.addIssue({ code: "custom", path: ["faceValueEuros"], message: "Discounted tickets need a face value" });
      if (o.discountPercent === undefined) ctx.addIssue({ code: "custom", path: ["discountPercent"], message: "Discounted tickets need a discount %" });
    }
    if (o.allocationType === "CAPPED" && !o.capacity) {
      ctx.addIssue({ code: "custom", path: ["capacity"], message: "Capped offers need a capacity" });
    }
    if (o.allocationType === "TIME_WINDOW") {
      if (!o.validUntilLocal) ctx.addIssue({ code: "custom", path: ["validUntilLocal"], message: "Time-window offers need an until time" });
      if (!o.afterWindowBehaviour) ctx.addIssue({ code: "custom", path: ["afterWindowBehaviour"], message: "Choose what happens after the window closes" });
    }
    if (o.privateSaleTiers.length > 0 && !o.privateSaleHoursBefore && !o.privateSaleOpensAt) {
      ctx.addIssue({ code: "custom", path: ["privateSaleHoursBefore"], message: "Private sale needs 24 or 48 hours (or an explicit opens-at)" });
    }
    if (o.privateSaleHoursBefore && !(PRIVATE_SALE_HOURS as readonly number[]).includes(o.privateSaleHoursBefore)) {
      ctx.addIssue({ code: "custom", path: ["privateSaleHoursBefore"], message: "Private sale is 24 or 48 hours" });
    }
  });

export type OfferInput = z.input<typeof OfferSchema>;
