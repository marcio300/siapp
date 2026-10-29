/**
 * CSV helpers (ported from EventOS src/lib/csv.ts). Money is integer cents and
 * exported as euros with 2 decimals via `eur()`.
 */
export type CsvValue = string | number | null | undefined;

/**
 * Spreadsheet formula injection: a text cell beginning with = + - @ (or a
 * tab/CR) is executed by Excel/Sheets when opened. Member-supplied strings
 * reach exports, so such cells get a leading apostrophe. Numbers stay as-is.
 */
export function escapeCsvCell(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n") + "\r\n";
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` },
  });
}

/** Integer cents → "12.34". */
export function eur(cents: number): string {
  return (cents / 100).toFixed(2);
}
