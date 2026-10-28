import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { PartnerError } from "./errors";

/**
 * Partner claim tokens (docs/PARTNER_TOKEN.md): a compact JWS signed RS256 by
 * the partner's private key. We verify with the PEM public key stored on the
 * PartnerCommunity row. No library: node:crypto does RSASSA-PKCS1-v1_5 /
 * SHA-256, and the payload shape is small enough to check by hand.
 */
export interface ClaimTokenPayload {
  source: string;
  externalMemberId: string;
  name?: string;
  email?: string;
  exp: number; // seconds since epoch
  iat?: number;
  jti?: string;
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** Header + payload without signature verification — only to find out which community signed. */
export function peekClaimToken(token: string): { header: { alg?: string; typ?: string; kid?: string }; payload: Partial<ClaimTokenPayload> } {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new PartnerError("malformed", "That doesn't look like a partner token");
  try {
    const header = JSON.parse(b64urlDecode(parts[0]!).toString("utf8")) as { alg?: string; typ?: string; kid?: string };
    const payload = JSON.parse(b64urlDecode(parts[1]!).toString("utf8")) as Partial<ClaimTokenPayload>;
    if (!header || typeof header !== "object" || !payload || typeof payload !== "object") throw new Error("shape");
    return { header, payload };
  } catch {
    throw new PartnerError("malformed", "That doesn't look like a partner token");
  }
}

export function parsePublicKey(pem: string): KeyObject {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "rsa") throw new Error("not rsa");
    return key;
  } catch {
    throw new PartnerError("bad_signature", "The partner's public key is not a valid RSA PEM");
  }
}

/** Full verification: RS256 signature, required claims, expiry. */
export function verifyClaimToken(token: string, publicKeyPem: string, opts: { now?: Date; clockSkewSeconds?: number } = {}): ClaimTokenPayload {
  const { header, payload } = peekClaimToken(token);
  if (header.alg !== "RS256") throw new PartnerError("unsupported_alg", "Partner tokens must be signed RS256");
  const [h, p, sig] = token.trim().split(".") as [string, string, string];
  const key = parsePublicKey(publicKeyPem);
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).end().verify(key, b64urlDecode(sig));
  if (!ok) throw new PartnerError("bad_signature", "This token wasn't issued by the partner (bad signature)");
  if (typeof payload.source !== "string" || !payload.source || typeof payload.externalMemberId !== "string" || !payload.externalMemberId) {
    throw new PartnerError("missing_claims", "The token is missing its source or member id");
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) throw new PartnerError("missing_claims", "The token has no expiry");
  const now = (opts.now ?? new Date()).getTime() / 1000;
  if (payload.exp + (opts.clockSkewSeconds ?? 60) < now) throw new PartnerError("expired", "This token has expired — ask the partner for a fresh one");
  return {
    source: payload.source,
    externalMemberId: payload.externalMemberId,
    name: typeof payload.name === "string" ? payload.name : undefined,
    email: typeof payload.email === "string" ? payload.email : undefined,
    exp: payload.exp,
    iat: typeof payload.iat === "number" ? payload.iat : undefined,
    jti: typeof payload.jti === "string" ? payload.jti : undefined,
  };
}
