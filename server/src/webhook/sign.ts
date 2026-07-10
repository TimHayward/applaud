import { createHmac } from "node:crypto";

/**
 * Signs `${timestampSec}.${rawBody}` (not the body alone), following the
 * Stripe/GitHub pattern, so receivers can reject stale/replayed requests by
 * checking the timestamp is recent in addition to verifying the signature.
 */
export function signPayload(secret: string, timestampSec: number, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex")}`;
}
