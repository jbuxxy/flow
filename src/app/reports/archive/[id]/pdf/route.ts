import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasFullAccess } from "@/lib/access";
import { db } from "@/lib/db";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasFullAccess(session.user)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const report = await db.report.findUnique({ where: { id }, select: { householdId: true, pdfBytes: true, periodKey: true } });
  if (!report || report.householdId !== session.user.householdId || !report.pdfBytes) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(report.pdfBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="flow-report-${report.periodKey}.pdf"`,
    },
  });
}
