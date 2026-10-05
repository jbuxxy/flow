import { hash, verify } from "@node-rs/argon2";

// Argon2id, memory-hard hashing — OWASP-recommended parameters for interactive login.
const OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export function verifyPassword(
  hashValue: string,
  password: string,
): Promise<boolean> {
  return verify(hashValue, password, OPTIONS);
}
