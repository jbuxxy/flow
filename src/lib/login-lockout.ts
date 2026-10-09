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
    // Reset the count as the lock starts, so the window that opens when it
    // expires gets a fresh MAX_ATTEMPTS. Leaving it at 5 meant every single
    // later typo re-locked the account for another 15 minutes until a
    // successful login (2026-10-08 review). The count >= MAX guard keeps
    // concurrent failures from each re-extending the lock.
    await db.user.updateMany({
      where: { id: userId, failedLoginCount: { gte: MAX_ATTEMPTS } },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_MS), failedLoginCount: 0 },
    });
  }
}

export async function recordSuccessfulLogin(userId: string) {
  await db.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
}
