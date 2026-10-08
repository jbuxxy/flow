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
  // a silent repair's new endpoint takes over that row.
  replaces: z.string().url().optional(),
  // Explicit "turn notifications on here" — see POST.
  exclusive: z.boolean().optional(),
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

  const userId = session.user.id;
  const { endpoint, keys, replaces, exclusive } = parsed.data;

  // "Turn notifications on here": this device becomes the person's only
  // subscription — one active at a time (household request, 2026-10-08).
  if (exclusive) {
    await db.$transaction([
      db.pushSubscription.upsert({
        where: { endpoint },
        create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
        update: { userId, p256dh: keys.p256dh, auth: keys.auth },
      }),
      db.pushSubscription.deleteMany({ where: { userId, endpoint: { not: endpoint } } }),
    ]);
    return NextResponse.json({ ok: true, active: true });
  }

  // The quiet re-send (page load / silent repair): refresh this device's row
  // if it's still the active one — by its own endpoint, or the one it's
  // replacing — but never create a row, so a stale browser can't take over.
  const own = await db.pushSubscription.findFirst({ where: { endpoint, userId }, select: { id: true } });
  const prior =
    own ??
    (replaces && replaces !== endpoint
      ? await db.pushSubscription.findFirst({ where: { endpoint: replaces, userId }, select: { id: true } })
      : null);
  if (!prior) return NextResponse.json({ ok: true, active: false });
  try {
    await db.pushSubscription.update({
      where: { id: prior.id },
      data: { endpoint, p256dh: keys.p256dh, auth: keys.auth },
    });
  } catch {
    // The new endpoint is already another account's (one device, two
    // logins) — that's the explicit-enable path's call to make, not this one.
    return NextResponse.json({ ok: true, active: false });
  }
  return NextResponse.json({ ok: true, active: true });
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
