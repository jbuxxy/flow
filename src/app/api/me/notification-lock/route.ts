import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

// The signed-in member's own notification master switch + owner lock, for
// useLiveNotificationLock to poll — so an owner locking/unlocking a member
// shows up on that member's phone within seconds, without a reload
// (household request, 2026-10-17). A route, not a server action, so a poll
// never queues behind another action.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await db.user.findUnique({
    where: { id: session.user.id },
    select: { notificationsEnabled: true, notificationsLocked: true },
  });
  return NextResponse.json(
    { enabled: me?.notificationsEnabled ?? false, locked: me?.notificationsLocked ?? false },
    { headers: { "Cache-Control": "no-store" } },
  );
}
