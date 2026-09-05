import { scrypt } from "@noble/hashes/scrypt";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const encoder = new TextEncoder();
/**
 * Tests may compile the Worker with `define: { "globalThis.POOL_PASSWORD_SCRYPT_LOG_N": "10" }`
 * (see tests/fixtures/wrangler.vitest.jsonc): production-cost scrypt would
 * dominate pool-fixture-heavy tests. Production builds never define this
 * constant, so the scrypt cost stays at N = 2^15, and the clamp keeps any
 * override memory-hard.
 */
const configuredLogN = (globalThis as Record<string, unknown>).POOL_PASSWORD_SCRYPT_LOG_N;
const logN = typeof configuredLogN === "number" && Number.isInteger(configuredLogN) && configuredLogN >= 10 && configuredLogN <= 15 ? configuredLogN : 15;
const parameters = { N: 1 << logN, r: 8, p: 1, dkLen: 32 };
const constantTimeEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.reduce((same, byte, index) => same & (byte === b[index] ? 1 : 0), 1) === 1;

/** Independent, versioned scrypt pool-password boundary. */
export function hashPoolPassword(password: string, salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  if (password.length < 8) throw new Error("Pool password must be at least eight characters.");
  return `scrypt-v1$${bytesToHex(salt)}$${bytesToHex(scrypt(encoder.encode(password), salt, parameters))}`;
}
export function verifyPoolPassword(password: string, encoded: string): boolean {
  const [version, salt, digest] = encoded.split("$");
  if (version !== "scrypt-v1" || !salt || !digest) return false;
  return constantTimeEqual(scrypt(encoder.encode(password), hexToBytes(salt), parameters), hexToBytes(digest));
}

/**
 * Authenticates a password-bearing command for idempotency storage. The key
 * is a Worker secret, never Durable Object storage, so records are not an
 * offline password verifier (including one cheaper than the pool scrypt hash).
 */
export function authenticatePoolSecret(secret: string, commandId: string, key: string): string {
  return bytesToHex(hmac(sha256, encoder.encode(key), encoder.encode(`${commandId}\u0000${secret}`)));
}
