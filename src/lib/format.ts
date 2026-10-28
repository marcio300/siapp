export function formatMoney(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(cents / 100);
}

/** All times are stored in UTC and displayed in the city's timezone. */
export function formatDate(d: Date | string, timezone = "Europe/Lisbon"): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(d));
}

export function formatDateOnly(d: Date | string, timezone = "Europe/Lisbon"): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: timezone,
  }).format(new Date(d));
}

/** Keys are always shown as "<key icon> N" in UI; this is the plain-text form for emails/logs. */
export function formatKeys(n: number): string {
  return `${n} ${n === 1 ? "key" : "keys"}`;
}
