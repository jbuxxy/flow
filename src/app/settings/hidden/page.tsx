import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getHiddenItems } from "@/lib/hidden-items";
import { AppShell } from "@/components/app-shell";
import { HiddenItems } from "@/app/settings/simplefin/hidden-items";

export default async function HiddenItemsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "OWNER") redirect("/");

  const hiddenItems = await getHiddenItems(session.user.householdId);

  return (
    <AppShell title="Hidden Accounts & Debts" user={session.user} breadcrumb={{ href: "/settings", label: "Settings" }} width="reading">

      <p className="text-xs text-gray-500 dark:text-neutral-400">
        These are hidden from /debts, Account Settings, and every bucket. Restore any of them at any
        time. Delete removes the record permanently — a manual debt right away, a synced account (or a
        debt still linked to one) once it has been hidden for a year. Transaction history stays put
        either way.
      </p>

      <HiddenItems items={hiddenItems} />
    </AppShell>
  );
}
