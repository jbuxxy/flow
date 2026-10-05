import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { AiProvider } from "@prisma/client";

const PROVIDER_LABEL: Record<AiProvider, string> = {
  GEMINI: "Gemini",
  OPENAI: "OpenAI",
  ANTHROPIC: "Anthropic",
  GROK: "Grok",
};

// The raw string we persist to HouseholdAiSettings.lastError is whatever the
// provider threw — usually a "<provider> request failed (429): {json blob}"
// wrapper around a truncated JSON error. Pull the HTTP status and the
// human-readable sentence back out so the card can show a tidy headline plus
// the provider's own explanation (links intact) instead of the blob.
function parseAiError(raw: string): { headline: string; code: number | null; detail: string } {
  const trimmed = raw.trim();

  const wrapped = trimmed.match(/request failed\s*\((\d{3})\):\s*([\s\S]*)$/i);
  const code = wrapped ? Number(wrapped[1]) : null;
  let body = wrapped ? wrapped[2] : trimmed;

  // Lenient on a truncated blob: the closing quote may have been cut off, so
  // accept end-of-string as a terminator too.
  const message = body.match(/"message"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
  if (message) body = message[1];

  body = body
    .replace(/\\"/g, '"')
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Drop a dangling sentence fragment left behind by the provider-side
  // truncation (".slice(0, 300)" in ai-provider.ts).
  if (body && !/[.!?)"]$/.test(body)) {
    const stop = Math.max(body.lastIndexOf(". "), body.lastIndexOf("! "), body.lastIndexOf("? "));
    if (stop > 40) body = body.slice(0, stop + 1);
  }

  const kind =
    code === 429
      ? "Rate Limit Exceeded"
      : code === 401 || code === 403
        ? "Authentication Failed"
        : code === 404
          ? "Model Not Found"
          : code === 400
            ? "Request Rejected"
            : code && code >= 500
              ? "Provider Unavailable"
              : "Connection Error";

  return { headline: kind, code, detail: body || trimmed };
}

// Ends on a non-punctuation char so a trailing "." or "," in the prose stays
// out of the href.
const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g;

function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <a
        key={start}
        href={match[0]}
        target="_blank"
        rel="noreferrer noopener"
        className="font-medium underline decoration-red-400 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-red-600 dark:decoration-red-500/70 dark:hover:decoration-red-400"
      >
        {match[0]}
      </a>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AiErrorNotice({ provider, raw }: { provider: AiProvider; raw: string }) {
  const { headline, code, detail } = parseAiError(raw);

  return (
    <div className="mt-3 rounded-lg border border-red-200 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 p-3">
      <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
        <AlertTriangle size={15} className="shrink-0" />
        <span className="text-sm font-semibold">
          {PROVIDER_LABEL[provider]} {headline}
        </span>
        {code != null && (
          <span className="ml-auto rounded-md bg-red-100 dark:bg-red-900/50 px-1.5 py-0.5 text-xs font-medium tabular-nums text-red-700 dark:text-red-300">
            {code}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm leading-relaxed [overflow-wrap:anywhere] text-red-700/90 dark:text-red-300/90">
        {linkify(detail)}
      </p>
    </div>
  );
}
