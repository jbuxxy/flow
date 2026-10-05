import { db } from "@/lib/db";

// Postgres-backed for now (User.failedLoginCount / lockedUntil). This is a
// small write on every attempt; fine at household scale. Worth moving to
// Redis (already planned) once connection details are wired up, mainly to
// take the write load off Postgres rather than for correctness.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export function isLocked(user: { lockedUntil: Date | null }): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
}

// Takes no `currentCount` from the caller on purpose — reading a count,
// then writing count+1 a moment later, is a classic TOCTOU race: several
// concurrent login attempts (trivial for an attacker to fire in parallel)
// can all read the same stale count and all write the same next value, so
// the real count of failed attempts never advances past what a single
// request would have produced and the lockout never trips. `{ increment: 1
// }` compiles to a single atomic `SET x = x + 1` at the database, so every
// concurrent attempt genuinely advances the count no matter how many race
// each other.
export async function recordFailedLogin(userId: string): Promise<void> {
  const { failedLoginCount } = await db.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  if (failedLoginCount >= MAX_ATTEMPTS) {
    await db.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_MS) },
    });
  }
}

export async function recordSuccessfulLogin(userId: string) {
  await db.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
}
