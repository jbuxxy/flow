import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { InviteForm } from "./invite-form";
import { MemberRow } from "./member-row";
import { MembersUsageSynopsis } from "./members-usage-synopsis";

export default async function MembersPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Owner-only — adding/editing members is a management action, not
  // something a Partner (full-financials, non-owner) gets to do.
  if (session.user.role !== "OWNER") redirect("/");

  const rawMembers = await db.user.findMany({
    where: { householdId: session.user.householdId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, role: true, totpEnabled: true, dashboardScope: true, passwordHash: true },
  });
  // Never hand the hash itself to the client — MemberRow only needs to know
  // whether setup is still pending (invited, hasn't used their link yet).
  const members = rawMembers.map(({ passwordHash, ...m }) => ({ ...m, needsSetup: passwordHash === null }));

  return (
    <AppShell title="Household Members" user={session.user} breadcrumb={{ href: "/settings", label: "Settings" }} width="reading">

      <MembersUsageSynopsis />

      <p className="text-sm text-gray-500 dark:text-neutral-400">
        Pick an access level and share the one-time invite link — the
        person joining sets their own name, email, and password (and, for
        Owner/Partner, enrolls two-factor login) without you filling in
        their identity or inventing a password for them.
      </p>

      <ul className="flex flex-col gap-2">
        {members.map((m) => (
          <MemberRow key={m.id} member={m} currentUserId={session.user.id} />
        ))}
      </ul>

      <InviteForm />
    </AppShell>
  );
}
