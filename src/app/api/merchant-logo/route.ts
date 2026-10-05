import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveMerchantLogoDomain } from "@/lib/merchant-logo-resolve";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const merchant = new URL(request.url).searchParams.get("merchant")?.trim();
  if (!merchant) {
    return NextResponse.json({ domain: null });
  }

  const domain = await resolveMerchantLogoDomain(merchant);
  return NextResponse.json({ domain });
}
