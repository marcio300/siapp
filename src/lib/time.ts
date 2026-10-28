/**
 * Timezone helpers without a dependency: everything is stored in UTC and
 * entered/displayed in the city's IANA timezone (CLAUDE.md rule 11).
 */

/** Offset (ms) of `timezone` from UTC at the given instant. */
export function tzOffsetMs(instant: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export interface LocalDateTime {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
}

/**
 * Local wall-clock time in `timezone` → UTC instant. Handles DST: a time
 * inside a spring-forward gap resolves to the instant after the gap; an
 * ambiguous fall-back time resolves to the first (DST) occurrence.
 */
export function localToUtc(local: LocalDateTime, timezone: string): Date {
  const [y, m, d] = local.date.split("-").map(Number);
  const [h, mi] = local.time.split(":").map(Number);
  if (!y || !m || !d || h === undefined || mi === undefined || Number.isNaN(h) || Number.isNaN(mi)) {
    throw new Error(`Invalid local date/time ${local.date} ${local.time}`);
  }
  const wall = Date.UTC(y, m - 1, d, h, mi);
  // Sample the zone's offset on both sides of the wall time: around a DST
  // switch the two differ and give two candidate instants.
  const offsets = new Set([-12, 0, 12].map((hrs) => tzOffsetMs(new Date(wall + hrs * 3_600_000), timezone)));
  const candidates = [...offsets].map((off) => wall - off).sort((a, b) => a - b);
  const wanted = `${local.date} ${local.time}`;
  const valid = candidates.filter((c) => {
    const back = utcToLocal(new Date(c), timezone);
    return `${back.date} ${back.time}` === wanted;
  });
  // Overlap: both valid → first occurrence (DST). Gap: none valid → the later
  // candidate, i.e. the instant just after the clocks jumped.
  return new Date(valid.length > 0 ? valid[0]! : candidates[candidates.length - 1]!);
}

/** UTC instant → local wall clock parts in `timezone` (for form defaults). */
export function utcToLocal(instant: Date, timezone: string): LocalDateTime {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * Guest-list windows are entered as a local time like "02:00" meaning "the
 * next time the clock shows 02:00 after the event starts". Returns the UTC
 * instant.
 */
export function windowUntilFromLocalTime(eventStartsAt: Date, timeLocal: string, timezone: string): Date {
  const start = utcToLocal(eventStartsAt, timezone);
  let candidate = localToUtc({ date: start.date, time: timeLocal }, timezone);
  if (candidate <= eventStartsAt) {
    const [y, m, d] = start.date.split("-").map(Number);
    const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
    candidate = localToUtc({ date: next.toISOString().slice(0, 10), time: timeLocal }, timezone);
  }
  return candidate;
}
