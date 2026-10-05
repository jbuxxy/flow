import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { createSetupToken } from "@/lib/setup-token";
import { SetupLinkExpired } from "@/components/setup-link-expired";

// The short link a household actually shares (see inviteHouseholdMember,
// src/app/settings/members/actions.ts, and User.inviteCode's schema
// comment for why this exists instead of just sharing the long signed
// token directly). Pure resolver: look up the code, mint a fresh
// full-strength setup token, hand off to the real flow. Never itself the
// credential a browser holds onto past this one redirect.
export default async function InvitePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  const user = await db.user.findUnique({
    where: { inviteCode: code },
    select: { id: true, inviteCodeExpiresAt: true },
  });
  if (!user || !user.inviteCodeExpiresAt || user.inviteCodeExpiresAt < new Date()) {
    return <SetupLinkExpired />;
  }

  const token = createSetupToken(user.id);
  redirect(`/setup-totp?token=${encodeURIComponent(token)}`);
}
