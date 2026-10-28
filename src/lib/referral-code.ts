import { randomBytes } from "node:crypto";

/** Unambiguous alphabet (no 0/O/1/I) so codes survive being read aloud at a door. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Random 8-char referral code. Uniqueness is enforced by the DB; retry on P2002. */
export function generateReferralCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}
