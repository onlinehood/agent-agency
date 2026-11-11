import { randomBytes, randomUUID } from "node:crypto";

/** Prefixed, sortable-ish opaque identifiers. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function nonce(bytes = 8): string {
  return randomBytes(bytes).toString("base64url");
}

export function nowIso(): string {
  return new Date().toISOString();
}
