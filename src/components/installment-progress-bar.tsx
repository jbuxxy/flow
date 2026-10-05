// "Payment 3 of 12" bar for an INSTALLMENT debt — shared by DebtRow (/debts),
// DebtPaymentCard (bucket page), and ManualDebtEditor (Account Settings), one
// per debt shown in a different context. Each caller derives its own
// `currentPayment` (installmentsTotal - installmentsRemaining + 1, checked
// against `!= null` rather than truthy — installmentsRemaining === 0 is a
// legit "fully paid off" value but falsy, and the bar must still render at
// 100% for it) and passes it in alongside the raw total.
//
// The gradient is painted across the FULL track (0-100%), not squeezed into
// just the paid-so-far width — a 50%-paid bar otherwise showed the whole
// blue-to-amber range compressed into its own half, which reads as further
// along than it is. A same-color cover slides in from the right to hide the
// not-yet-reached slice, so only a debt that's fully paid off ever shows the
// true end-to-end gradient.
export function InstallmentProgressBar({
  currentPayment,
  total,
  className = "",
}: {
  currentPayment: number;
  total: number;
  className?: string;
}) {
  const completed = Math.min(currentPayment - 1, total);
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-gradient-to-r from-blue-900 via-emerald-500 to-amber-400">
        <div
          className="absolute inset-y-0 right-0 bg-neutral-200 dark:bg-neutral-800"
          style={{ width: `${100 - (completed / total) * 100}%` }}
        />
      </div>
      <span className="shrink-0 text-[10px] text-gray-400 dark:text-neutral-500">
        {completed}/{total}
      </span>
    </div>
  );
}
