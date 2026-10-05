import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { MemberNotificationPrefs } from "./member-notification-prefs";
import { NotificationsUsageSynopsis } from "./notifications-usage-synopsis";

export default async function NotificationSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const isOwner = session.user.role === "OWNER";

  const members = isOwner
    ? (
        await db.user.findMany({
          where: { householdId: session.user.householdId },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            dashboardScope: true,
            notificationsEnabled: true,
            notificationsLocked: true,
          },
        })
      ).map((m) => ({ ...m, name: m.name ?? "Pending Invite", email: m.email ?? "" }))
    : [
        {
          id: session.user.id,
          name: session.user.name ?? "",
          email: "",
          role: session.user.role as "OWNER" | "PARENT" | "CHILD",
          dashboardScope: session.user.dashboardScope as "FULL" | "BUCKETS_ONLY",
          ...(await db.user.findUniqueOrThrow({
            where: { id: session.user.id },
            select: { notificationsEnabled: true, notificationsLocked: true },
          })),
        },
      ];

  const prefs = await db.notificationPreference.findMany({
    where: { userId: { in: members.map((m) => m.id) } },
  });
  const prefsByUser = new Map<string, Record<string, boolean>>();
  for (const m of members) prefsByUser.set(m.id, {});
  for (const p of prefs) {
    const entry = prefsByUser.get(p.userId);
    if (entry) entry[p.type] = p.enabled;
  }

  // One member → a single preference card, keep it a centered reading column.
  // Multiple → lay the per-member cards out in a grid on the wide canvas.
  const multiMember = members.length > 1;

  return (
    <AppShell
      title="Notifications"
      user={session.user}
      breadcrumb={{ href: "/settings", label: "Settings" }}
      width={multiMember ? "wide" : "reading"}
    >

      <NotificationsUsageSynopsis />

      <p className="text-sm text-gray-500 dark:text-neutral-400">
        {isOwner
          ? "Choose what each household member gets notified about."
          : "Choose what you get notified about."}
      </p>

      <ul className={multiMember ? "grid gap-4 lg:grid-cols-2 lg:items-start" : "flex flex-col gap-4"}>
        {members.map((m) => (
          <MemberNotificationPrefs
            key={m.id}
            member={m}
            preferences={prefsByUser.get(m.id) ?? {}}
            canEdit={isOwner || m.id === session.user.id}
            // Only an owner locks, and never their own switch.
            canLock={isOwner && m.id !== session.user.id}
            showName={isOwner}
            collapsible={members.length > 1}
          />
        ))}
      </ul>
    </AppShell>
  );
}
