/**
 * CLAUDE.md rule 6 / spec §12: the producer is owed `face × (1 − discount%)`
 * per SCANNED discounted ticket, in integer cents, rounded half up.
 */
export function owedCents(faceValueCents: number, discountPercent: number): number {
  if (!Number.isInteger(faceValueCents) || faceValueCents < 0) throw new RangeError("faceValueCents must be a non-negative integer");
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) throw new RangeError("discountPercent must be 0–100");
  // Integer arithmetic: face × (100 − d) / 100, half up.
  const numerator = faceValueCents * (100 - discountPercent);
  return Math.floor((numerator + 50) / 100);
}
