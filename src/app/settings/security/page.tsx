import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { PasskeyPanel } from "./passkey-panel";

// Personal login security — not gated by role/dashboardScope like most of
// /settings, since it's about how THIS person signs in, not what they can
// see once they're in (a CHILD account can set up Face ID too).
export default async function SecuritySettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const credentials = await db.webAuthnCredential.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, nickname: true, createdAt: true, lastUsedAt: true, transports: true },
  });

  // Formatted server-side (container TZ, same convention as the SimpleFIN
  // "last synced" timestamp, settings/accounts/page.tsx) and passed down as
  // a plain string — a client component re-running toLocaleDateString on the
  // same Date at hydration risks a server/browser TZ mismatch (see
  // src/lib/date.ts's formatDate comment); this side-steps it entirely by
  // never formatting on the client at all.
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <AppShell title="Sign-In & Security" user={session.user} breadcrumb={{ href: "/settings", label: "Settings" }} width="reading">
      <PasskeyPanel
        initialCredentials={credentials.map((c) => ({
          id: c.id,
          nickname: c.nickname,
          addedLabel: fmt(c.createdAt),
          lastUsedLabel: c.lastUsedAt ? fmt(c.lastUsedAt) : null,
        }))}
      />
    </AppShell>
  );
}
