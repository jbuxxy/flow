import { Receipt } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatISODate } from "@/lib/date";
import { MerchantLogo } from "@/components/merchant-logo";
import type { ReceiptLineItem } from "@/app/transactions/transaction-row";

// "From Receipt" detail box — shared by /transactions' TransactionRow and
// the bucket page's own TransactionRow, which otherwise hand-copied this
// exact block. Renders nothing when there's no itemization, note, "paid
// with" line, or even a bare match to show.
export function ReceiptDetailBlock({
  hasReceipt,
  receiptItems,
  receiptNote,
  receiptPaidWith,
  receiptDate,
  receiptTotalCents,
  p2pTitle,
}: {
  hasReceipt: boolean;
  receiptItems: ReceiptLineItem[] | null;
  receiptNote: string | null;
  receiptPaidWith: string | null;
  receiptDate: string | null;
  receiptTotalCents: number | null;
  // Suppresses the "Paid With X" line when the row's own title already
  // surfaced it (a matched P2P receipt) — same guard both TransactionRow
  // variants use (see deriveP2PDisplay, src/lib/transaction-display.ts).
  p2pTitle: string | null;
}) {
  const showPaidWith = Boolean(receiptPaidWith && !p2pTitle);
  const hasItems = !!receiptItems && receiptItems.length > 0;
  // A linked receipt with none of the above — a bare match (amount + date
  // only, no line items or note, e.g. a gas-station email). Still worth a
  // block: the title icon promised one, and the date/total confirm it's the
  // right charge.
  const bareReceipt = hasReceipt && !hasItems && !receiptNote && !showPaidWith;
  if (!hasItems && !receiptNote && !showPaidWith && !bareReceipt) return null;
  return (
    <div className="rounded-lg border border-blue-100 bg-blue-50/40 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900/40">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
        <Receipt size={12} className="shrink-0" /> From Receipt
      </p>
      {bareReceipt && (
        <p className="mt-1 text-xs text-gray-600 dark:text-neutral-400">
          {[
            receiptDate && formatISODate(receiptDate, { month: "short", day: "numeric", year: "numeric" }),
            receiptTotalCents != null && `Total ${formatCents(receiptTotalCents)}`,
          ]
            .filter(Boolean)
            .join(" · ") || "Receipt Attached — No Itemized Detail"}
        </p>
      )}
      {showPaidWith && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-600 dark:text-neutral-400">
          <MerchantLogo merchant={receiptPaidWith!} size={12} />
          Paid With {receiptPaidWith}
        </p>
      )}
      {receiptNote && (
        <p className="mt-1 text-xs italic text-gray-600 dark:text-neutral-400">&ldquo;{receiptNote}&rdquo;</p>
      )}
      {hasItems && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {receiptItems!.map((item, i) => (
            <li key={i} className="flex justify-between gap-2 text-xs text-gray-600 dark:text-neutral-400">
              <span className="min-w-0 truncate">
                {item.qty && item.qty > 1 ? `${item.qty}× ` : ""}
                {item.description}
              </span>
              {item.totalCents != null && <span className="shrink-0">{formatCents(item.totalCents)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
