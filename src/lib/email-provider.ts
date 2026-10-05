// Per-user IMAP mailbox client — dispatches nothing (there's only one
// protocol), but otherwise mirrors src/lib/ai-provider.ts: decrypt the
// stored secret, keep a self-healing status/lastError on the row, and never
// throw out of the poll path (a broken mailbox must not stop a bank sync).
//
// Read-only by construction: every mailbox is opened `{ readOnly: true }`
// and messages are fetched without touching `\Seen` — see WORKING_ON.md.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { assertPublicHost } from "@/lib/ssrf-guard";

export type EmailConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
};

export type EmailConnectionRow = {
  id: string;
  userId: string;
  householdId: string;
  config: EmailConfig;
  lastSeenUid: number | null;
  oldestPolledUid: number | null;
  lastPolledAt: Date | null;
};

// A single fetched message, already reduced to what the parser/prefilter
// need — raw bodies are never persisted.
export type RawEmail = {
  uid: number;
  messageId: string;
  receivedAt: Date;
  subject: string;
  from: string;
  text: string;
};

// Gmail (and every other provider we care about) uses implicit TLS on 993;
// 143 would be STARTTLS. No plaintext fallback.
function isSecurePort(port: number): boolean {
  return port !== 143;
}

function buildClient(config: EmailConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: isSecurePort(config.port),
    auth: { user: config.user, pass: config.password },
    // One-shot fetches, not a long-lived idle connection.
    disableAutoIdle: true,
    logger: false,
    // Keep a stuck server from hanging the whole sync.
    socketTimeout: 30_000,
  });
}

// All connected mailboxes for a household, newest first, with the IMAP
// password decrypted. A row whose secret can't be decrypted (rotated
// ENCRYPTION_KEY, corruption) is skipped with a log rather than throwing —
// same defensive posture as getHouseholdAiConfig.
export async function getEmailConnections(householdId: string): Promise<EmailConnectionRow[]> {
  const rows = await db.emailConnection.findMany({
    where: { householdId },
    orderBy: { createdAt: "desc" },
  });

  const out: EmailConnectionRow[] = [];
  for (const row of rows) {
    try {
      out.push({
        id: row.id,
        userId: row.userId,
        householdId: row.householdId,
        config: {
          host: row.imapHost,
          port: row.imapPort,
          user: row.imapUser,
          password: decrypt(row.imapPasswordEncrypted),
        },
        lastSeenUid: row.lastSeenUid,
        oldestPolledUid: row.oldestPolledUid,
        lastPolledAt: row.lastPolledAt,
      });
    } catch (err) {
      console.error(
        `[email-provider] failed to decrypt stored password for connection ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}

// "Needs attention" for a member's mailbox — no row is *not* an error here
// (unlike AI, email is fully optional and has no Settings badge), so this is
// only ever true when at least one of the member's connections (a member
// can have more than one — see the schema comment on EmailConnection.userId)
// is configured-but-broken.
export async function emailConnectionHasError(userId: string): Promise<boolean> {
  const count = await db.emailConnection.count({ where: { userId, status: "ERROR" } });
  return count > 0;
}

// Best-effort — a row can vanish mid-poll (the user just hit Disconnect),
// which isn't itself worth a loud log.
export async function recordEmailHealth(connectionId: string, error: string | null): Promise<void> {
  try {
    await db.emailConnection.update({
      where: { id: connectionId },
      data: { status: error ? "ERROR" : "ACTIVE", lastError: error },
    });
  } catch {
    // no-op
  }
}

// Save-time verification — a real login, not just "something was typed".
// Returns null on success or a human-readable error for the connect form.
// Bypasses recordEmailHealth (no persisted row yet — connectEmail decides
// whether to persist based on this result).
export async function verifyEmailConfig(config: EmailConfig): Promise<string | null> {
  try {
    await assertPublicHost(config.host);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: isSecurePort(config.port),
    auth: { user: config.user, pass: config.password },
    logger: false,
    socketTimeout: 30_000,
    // Logs out immediately after a successful AUTH — all we need to confirm
    // the credentials work.
    verifyOnly: true,
  });
  try {
    await client.connect();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

const MAX_BODY_CHARS = 8_000;
const MAX_MESSAGES_PER_POLL = 200;

function bodyText(parsedText: string | undefined, parsedHtml: string | false | undefined): string {
  if (parsedText && parsedText.trim()) return parsedText.slice(0, MAX_BODY_CHARS);
  if (typeof parsedHtml === "string" && parsedHtml.trim()) {
    // Cheap tag strip — the AI extractor only needs the human-readable text,
    // and mailparser already gives us `.text` for most real mail anyway.
    const stripped = parsedHtml
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, MAX_BODY_CHARS);
  }
  return "";
}

export const RECEIPT_BATCH_LIMIT = MAX_MESSAGES_PER_POLL;

export type WindowOpts = {
  sinceDate: Date;
  newerThanUid?: number;
  olderThanUid?: number;
  limit: number;
  // Which end of the matched range to take `limit` from, and the order
  // `messages` come back in. "desc" (default) = newest first, for the
  // backfill. "asc" = oldest first, for draining a forward gap
  // chronologically so a forward-only cursor never skips the middle.
  order?: "asc" | "desc";
};

export type MailboxSession = {
  // One bounded slice of INBOX, always intersected with the 90-day date
  // floor and always returned NEWEST-FIRST. `newerThanUid` walks forward
  // from the steady-state cursor; `olderThanUid` walks the backfill backward
  // from the ceiling. `totalMatched` is how many messages matched before the
  // limit, so the caller knows whether another page remains.
  fetchWindow(opts: WindowOpts): Promise<{ messages: RawEmail[]; totalMatched: number }>;
  close(): Promise<void>;
};

// Opens one read-only INBOX session for the caller to run several
// fetchWindow calls against — a full backfill is many pages, and a fresh
// login per page hammers the provider's connection limits.
export async function openMailbox(config: EmailConfig): Promise<MailboxSession> {
  // Re-checked on every poll, not just at save time — see ssrf-guard.ts.
  await assertPublicHost(config.host);
  const client = buildClient(config);
  await client.connect();
  const lock = await client.getMailboxLock("INBOX", { readOnly: true });

  return {
    async fetchWindow(opts) {
      const query: Record<string, unknown> = { since: opts.sinceDate };
      if (opts.newerThanUid != null) query.uid = `${opts.newerThanUid + 1}:*`;
      else if (opts.olderThanUid != null) query.uid = `1:${Math.max(1, opts.olderThanUid - 1)}`;

      const found = await client.search(query, { uid: true });
      if (!found || found.length === 0) return { messages: [], totalMatched: 0 };

      // `uid:<n+1>:*` / `1:<n-1>` can still return a boundary message the
      // server rounds in — enforce the strict bound here.
      let matched = found;
      if (opts.newerThanUid != null) matched = matched.filter((u) => u > opts.newerThanUid!);
      if (opts.olderThanUid != null) matched = matched.filter((u) => u < opts.olderThanUid!);
      if (matched.length === 0) return { messages: [], totalMatched: 0 };

      const asc = opts.order === "asc";
      matched.sort((a, b) => (asc ? a - b : b - a));
      const take = matched.slice(0, opts.limit);

      const messages: RawEmail[] = [];
      for await (const msg of client.fetch(
        take,
        { uid: true, source: true, envelope: true, internalDate: true },
        { uid: true },
      )) {
        if (!msg.source) continue;
        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch {
          continue;
        }
        const messageId = parsed.messageId ?? msg.envelope?.messageId ?? `uid-${msg.uid}@${config.host}`;
        const internalDate =
          msg.internalDate instanceof Date
            ? msg.internalDate
            : msg.internalDate
              ? new Date(msg.internalDate)
              : undefined;
        const from =
          parsed.from?.text ??
          msg.envelope?.from?.map((a) => a.address).filter(Boolean).join(", ") ??
          "";
        messages.push({
          uid: msg.uid,
          messageId,
          receivedAt: internalDate ?? parsed.date ?? new Date(),
          subject: parsed.subject ?? msg.envelope?.subject ?? "",
          from,
          text: bodyText(parsed.text, parsed.html),
        });
      }
      // `fetch` doesn't guarantee order — restore the requested one.
      messages.sort((a, b) => (asc ? a.uid - b.uid : b.uid - a.uid));
      return { messages, totalMatched: matched.length };
    },

    async close() {
      try {
        lock.release();
      } catch {
        // already released
      }
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}
