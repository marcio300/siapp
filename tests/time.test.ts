import { describe, expect, it } from "vitest";
import { localToUtc, tzOffsetMs, utcToLocal, windowUntilFromLocalTime } from "@/lib/time";

const LISBON = "Europe/Lisbon";

describe("timezone helpers (Lisbon, DST both ways)", () => {
  it("offsets: winter 0, summer +1 h", () => {
    expect(tzOffsetMs(new Date("2026-01-15T12:00:00Z"), LISBON)).toBe(0);
    expect(tzOffsetMs(new Date("2026-07-15T12:00:00Z"), LISBON)).toBe(3_600_000);
  });

  it("local → UTC: summer wall clock is one hour ahead of UTC, winter equal", () => {
    expect(localToUtc({ date: "2026-07-18", time: "23:00" }, LISBON).toISOString()).toBe("2026-07-18T22:00:00.000Z");
    expect(localToUtc({ date: "2026-12-05", time: "23:00" }, LISBON).toISOString()).toBe("2026-12-05T23:00:00.000Z");
    expect(localToUtc({ date: "2026-07-19", time: "00:30" }, LISBON).toISOString()).toBe("2026-07-18T23:30:00.000Z");
  });

  it("spring forward (29 Mar 2026, 01:00 → 02:00): the skipped hour resolves after the gap", () => {
    expect(localToUtc({ date: "2026-03-29", time: "00:30" }, LISBON).toISOString()).toBe("2026-03-29T00:30:00.000Z");
    expect(localToUtc({ date: "2026-03-29", time: "02:30" }, LISBON).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    // 01:30 does not exist that night — lands at 02:30 local = 01:30Z, never before the gap
    expect(localToUtc({ date: "2026-03-29", time: "01:30" }, LISBON).getTime()).toBeGreaterThanOrEqual(Date.parse("2026-03-29T01:00:00Z"));
  });

  it("fall back (25 Oct 2026, 02:00 → 01:00): the ambiguous hour resolves to its first occurrence", () => {
    expect(localToUtc({ date: "2026-10-25", time: "00:30" }, LISBON).toISOString()).toBe("2026-10-24T23:30:00.000Z");
    expect(localToUtc({ date: "2026-10-25", time: "01:30" }, LISBON).toISOString()).toBe("2026-10-25T00:30:00.000Z"); // first 01:30 (still DST)
    expect(localToUtc({ date: "2026-10-25", time: "03:00" }, LISBON).toISOString()).toBe("2026-10-25T03:00:00.000Z");
  });

  it("round-trips UTC → local → UTC", () => {
    for (const iso of ["2026-02-01T23:15:00Z", "2026-08-01T21:45:00Z", "2026-10-25T05:00:00Z"]) {
      const d = new Date(iso);
      expect(localToUtc(utcToLocal(d, LISBON), LISBON).toISOString()).toBe(d.toISOString());
    }
  });

  it("guest-list window 'until 02:00' is the next 02:00 after the event starts, across DST", () => {
    // Summer: event Sat 23:00 local (22:00Z) → window ends Sun 02:00 local = 01:00Z
    const summerStart = localToUtc({ date: "2026-07-18", time: "23:00" }, LISBON);
    expect(windowUntilFromLocalTime(summerStart, "02:00", LISBON).toISOString()).toBe("2026-07-19T01:00:00.000Z");
    // Winter: event 23:00 local = 23:00Z → 02:00 local = 02:00Z next day
    const winterStart = localToUtc({ date: "2026-12-05", time: "23:00" }, LISBON);
    expect(windowUntilFromLocalTime(winterStart, "02:00", LISBON).toISOString()).toBe("2026-12-06T02:00:00.000Z");
    // The night the clocks fall back: event Sat 24 Oct 23:00 (22:00Z); "until 03:00" is Sunday 03:00 WET = 03:00Z
    const fallBackStart = localToUtc({ date: "2026-10-24", time: "23:00" }, LISBON);
    expect(windowUntilFromLocalTime(fallBackStart, "03:00", LISBON).toISOString()).toBe("2026-10-25T03:00:00.000Z");
    // A time later the same day stays on that day (daytime event 14:00 → until 18:00)
    const day = localToUtc({ date: "2026-07-18", time: "14:00" }, LISBON);
    expect(windowUntilFromLocalTime(day, "18:00", LISBON).toISOString()).toBe("2026-07-18T17:00:00.000Z");
    // Exactly the start time → next day
    expect(windowUntilFromLocalTime(day, "14:00", LISBON).toISOString()).toBe("2026-07-19T13:00:00.000Z");
  });
});
