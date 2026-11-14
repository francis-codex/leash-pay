import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** The owner's key. Short or missing = owner actions are off, never open. */
export const ownerKey = () => {
  const k = process.env.LEASH_OWNER_KEY ?? "";
  return k.length >= 16 ? k : null;
};

const sha = (s: string) => createHash("sha256").update(s).digest();

export function isOwner(given: string | null | undefined): boolean {
  const k = ownerKey();
  if (!k || !given) return false;
  return timingSafeEqual(sha(given), sha(k));
}
