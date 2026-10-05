import { AlertTriangle } from "lucide-react";

// SimpleFIN reports one free-text string per troubled institution in its
// `errors` array (see fetchSimpleFinData) — near-templated as
// "Connection to <Institution> may need attention. <Reason>". Pull the
// institution and reason back out so the card shows a tidy headline plus the
// institution name plus a plain-language next step, instead of dumping the
// raw sentence. Anything that doesn't match the template falls back to the
// raw text under a generic headline.
function parseSimpleFinError(raw: string): {
  headline: string;
  institution: string | null;
  detail: string;
} {
  const text = raw.trim().replace(/\s+/g, " ");

  const m = text.match(/^Connection to (.+?) may need attention[.:]?\s*(.*)$/i);
  const institution = m ? m[1].trim().replace(/[.,]$/, "") : null;
  const reason = m ? m[2].trim().replace(/[.]$/, "") : "";

  const needsReauth = /auth|login|credential|password|expired|re-?connect|MFA|multi-?factor/i.test(
    reason || text,
  );

  if (needsReauth) {
    return {
      headline: "Reconnect Required",
      institution,
      detail:
        "The saved login for this institution has expired. Reconnect it on SimpleFIN to resume syncing.",
    };
  }

  return {
    headline: institution ? "Connection Needs Attention" : "Sync Error",
    institution,
    detail: reason
      ? `${reason[0].toUpperCase()}${reason.slice(1)}. Check this connection on SimpleFIN.`
      : institution
        ? "This institution reported a problem. Check the connection on SimpleFIN."
        : text,
  };
}

export function SimpleFinErrorNotice({ raw }: { raw: string }) {
  const { headline, institution, detail } = parseSimpleFinError(raw);

  return (
    <li className="rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 p-3">
      <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
        <AlertTriangle size={15} className="shrink-0" />
        <span className="text-sm font-semibold">{headline}</span>
      </div>
      {institution && (
        <p className="mt-1.5 text-sm font-medium text-red-800 dark:text-red-300">{institution}</p>
      )}
      <p className="mt-0.5 text-sm leading-relaxed text-red-700/90 dark:text-red-300/90">{detail}</p>
      <div className="mt-3 flex justify-end">
        <a
          href="https://bridge.simplefin.org"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-red-800 dark:text-red-300 underline underline-offset-2 decoration-red-400 hover:decoration-red-600 dark:decoration-red-500/70 dark:hover:decoration-red-400"
        >
          Manage on SimpleFIN &rarr;
        </a>
      </div>
    </li>
  );
}
