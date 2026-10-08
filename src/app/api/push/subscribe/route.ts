import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  // This device's previous endpoint (push-client.ts's registerWithServer) —
  // retired so a re-enable replaces the old row rather than duplicating it.
  replaces: z.string().url().optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = subscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
  }

  await db.pushSubscription.upsert({
    where: { endpoint: parsed.data.endpoint },
    create: {
      userId: session.user.id,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    },
    update: {
      userId: session.user.id,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    },
  });

  if (parsed.data.replaces && parsed.data.replaces !== parsed.data.endpoint) {
    await db.pushSubscription
      .deleteMany({ where: { endpoint: parsed.data.replaces, userId: session.user.id } })
      .catch(() => {});
  }

  return NextResponse.json({ ok: true });
}

// Whether this user still has a subscription row for `endpoint` — the
// server deletes one as soon as the push service reports it gone (push.ts),
// so this is the device's real "am I still getting pushes" answer when iOS's
// own pushManager.getSubscription() says null (push-client.ts).
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const endpoint = new URL(request.url).searchParams.get("endpoint");
  if (!endpoint) return NextResponse.json({ active: false });
  const row = await db.pushSubscription.findFirst({
    where: { endpoint, userId: session.user.id },
    select: { id: true },
  });
  return NextResponse.json({ active: row !== null });
}

const unsubscribeSchema = z.object({ endpoint: z.string().url() });

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = unsubscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // An owner locked this member's notifications on (User.notificationsLocked)
  // — their device can't opt itself out while the lock stands.
  const me = await db.user.findUnique({
    where: { id: session.user.id },
    select: { notificationsEnabled: true, notificationsLocked: true },
  });
  if (me?.notificationsLocked && me.notificationsEnabled) {
    return NextResponse.json({ error: "Notifications are locked on by the household owner." }, { status: 403 });
  }

  await db.pushSubscription
    .deleteMany({ where: { endpoint: parsed.data.endpoint, userId: session.user.id } })
    .catch(() => {});

  return NextResponse.json({ ok: true });
}
