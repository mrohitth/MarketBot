import { Transaction } from "./types";
import Imap = require("imap");

const GMAIL_IMAP_HOST = "imap.gmail.com";
const GMAIL_IMAP_PORT = 993;

/**
 * Gmail Transaction Parser
 *
 * Scans Gmail inbox for Discover "Transaction Alert" emails.
 *
 * Actual email format (discover@services.discover.com):
 *   HTML part (partID "2") contains:
 *     Merchant: TST*MUMBAI CENTRAL<br/>
 *     Date: May 03, 2026<br/>
 *     Amount: $11.00<br/>
 *
 * Text part (partID "1") has empty field values (pending authorization).
 * HTML is the source of truth — field values only populated post-authorization.
 */
export interface GmailTransaction {
  id: string;
  date: string;
  merchant: string;
  amount: number;
  rawSubject: string;
  receivedAt: string;
  /** True if this is a pre-authorization hold that may be adjusted or cancelled before posting */
  pending?: boolean;
}

/**
 * Parse a Discover transaction alert email body (HTML content).
 *
 * Discover sends transaction alerts as multipart/alternative (text + HTML).
 * The text/plain part has empty fields (pending pre-auth).
 * The text/html part has actual values but they're embedded in table rows.
 *
 * Example HTML snippet:
 *   Merchant: TST*MUMBAI CENTRAL<br/>
 *   Date: May 03, 2026<br/>
 *   Amount: $11.00<br/>
 *
 * Returns null if no parseable merchant+amount found.
 */
function parseDiscoverHTML(htmlBody: string): GmailTransaction | null {
  // Decode quoted-printable
  const body = htmlBody
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/=\r?\n/g, "");

  let merchant: string | undefined;
  let dateStr: string | undefined;
  let amount: number | undefined;

  // ── Primary: HTML inline format ───────────────────────────────────────────
  // Merchant: VALUE<br/>  |  Date: VALUE<br/>  |  Amount: $VALUE<br/>
  const mMatch = body.match(/Merchant:\s*([^\s<][^<]*?)\s*<br/i);
  const dMatch = body.match(/Date:\s*([^\n<]+?)\s*<br/i);
  const aMatch = body.match(/Amount:\s*\$?([\d,]+\.\d{2})\s*<br/i);

  if (mMatch) merchant = mMatch[1].trim().toUpperCase();
  if (aMatch) amount = parseFloat(aMatch[1].replace(",", ""));

  if (dMatch) {
    const raw = dMatch[1].trim();
    const parsed = new Date(raw);
    dateStr = !isNaN(parsed.getTime())
      ? parsed.toISOString().split("T")[0]
      : raw;
  }

  const isPending = merchant ? /uber|pending|ubr/i.test(merchant) : false;
  if (!merchant && !amount) return null;
  if (!merchant) merchant = "UNKNOWN";
  if (amount === undefined) return null;
  if (!dateStr) dateStr = new Date().toISOString().split("T")[0];

  const id = `gmail-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  return {
    id,
    date: dateStr,
    merchant,
    amount: -amount,
    rawSubject: "Transaction Alert",
    receivedAt: new Date().toISOString(),
    pending: isPending,
  };
}

/**
 * Scan Gmail inbox for Discover transaction alerts.
 *
 * Searches both discover@services.discover.com and service@email.discover.com,
 * deduplicates by message sequence number, and parses the HTML part for field values.
 *
 * Requires: GMAIL_APP_PASSWORD env var (or pass directly)
 */
export async function scanGmailForDiscoverAlerts(
  gmailUser: string,
  gmailAppPassword: string
): Promise<GmailTransaction[]> {
  return new Promise((resolve, reject) => {
    const transactions: GmailTransaction[] = [];

    const imap = new Imap({
      user: gmailUser,
      password: gmailAppPassword,
      host: GMAIL_IMAP_HOST,
      port: GMAIL_IMAP_PORT,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    function openInbox(cb: (err: Error | null, box?: Imap.Box) => void) {
      imap.openBox("INBOX", true, cb);
    }

    imap.once("ready", () => {
      openInbox((err, box) => {
        if (err || !box) {
          imap.end();
          reject(err || new Error("Failed to open inbox"));
          return;
        }

        // Search both sender addresses, deduplicate with Set
        imap.search(
          [
            [
              "OR",
              ["FROM", "discover@services.discover.com"],
              ["FROM", "service@email.discover.com"],
            ],
            ["SUBJECT", "Transaction Alert"],
            ["UNSEEN"],
          ],
          (err: Error | null, results: number[]) => {
            if (err) {
              imap.end();
              reject(err);
              return;
            }

            if (results.length === 0) {
              imap.end();
              resolve([]);
              return;
            }

            // Deduplicate: some messages may match both FROM addresses
            const uniqueMsgIds = [...new Set(results)];
            console.log(
              `[GMAIL] Found ${results.length} alerts (${uniqueMsgIds.length} unique after dedup)`
            );

            // Fetch part 2 (HTML) for each unique message
            const fetch = imap.fetch(uniqueMsgIds, {
              bodies: "2", // partID "2" = text/html
              struct: true,
            });

            fetch.on("message", (msg) => {
              let buf = "";
              msg.on("body", (stream) => {
                stream.on("data", (chunk) => {
                  buf += chunk.toString("utf8");
                });
              });
              msg.on("end", () => {
                const txn = parseDiscoverHTML(buf);
                if (txn) {
                  transactions.push(txn);
                }
              });
            });

            fetch.once("error", (err: Error) => {
              imap.end();
              reject(err);
            });

            fetch.once("end", () => {
              imap.end();
              resolve(transactions);
            });
          }
        );
      });
    });

    imap.once("error", (err: Error) => {
      reject(err);
    });

    imap.connect();
  });
}

/**
 * Convert Gmail transaction to standard Transaction format
 */
export function gmailToTransaction(gmail: GmailTransaction): Transaction {
  return {
    date: gmail.date,
    description: gmail.merchant.toUpperCase(),
    amount: gmail.amount,
    category: mapCategoryFromMerchant(gmail.merchant),
    merchant: gmail.merchant,
  };
}

/**
 * Map merchant name to Discover/budget category.
 */
function mapCategoryFromMerchant(merchant: string): string {
  const lower = merchant.toLowerCase();

  if (
    lower.includes("uber") ||
    lower.includes("doordash") ||
    lower.includes("chipotle") ||
    lower.includes("starbucks") ||
    lower.includes("trader") ||
    lower.includes("restaurant") ||
    lower.includes("pizza") ||
    lower.includes("food") ||
    lower.includes("pita") ||
    lower.includes("grubhub") ||
    lower.includes("mcdonald") ||
    lower.includes("chick-fil-a") ||
    lower.includes("wing") ||
    lower.includes("dunkin") ||
    lower.includes("coffee")
  ) {
    return "Dining";
  }
  if (
    lower.includes("amazon") ||
    lower.includes("target") ||
    lower.includes("shop") ||
    lower.includes("walgreens") ||
    lower.includes("cvs") ||
    lower.includes("costco") ||
    lower.includes("bjs")
  ) {
    return "Discretionary";
  }
  if (
    lower.includes("zelle") ||
    lower.includes("rent") ||
    lower.includes("venmo")
  ) {
    return "Housing";
  }
  if (
    lower.includes("lyft") ||
    lower.includes("parking") ||
    lower.includes("metro") ||
    lower.includes("gas") ||
    lower.includes("shell") ||
    lower.includes("exxon") ||
    lower.includes("bp ")
  ) {
    return "Transportation";
  }
  if (
    lower.includes("netflix") ||
    lower.includes("spotify") ||
    lower.includes("hulu") ||
    lower.includes("disney") ||
    lower.includes("subscription")
  ) {
    return "Subscriptions";
  }

  return "Other";
}

/**
 * Deduplicate transactions from CSV and Gmail.
 * CSV wins for duplicates (audited record).
 */
export function deduplicateTransactions(
  csvTransactions: Transaction[],
  gmailTransactions: GmailTransaction[]
): Transaction[] {
  const seen = new Set<string>();
  const result: Transaction[] = [];

  for (const txn of csvTransactions) {
    const key = `${txn.date}-${txn.merchant}-${Math.abs(txn.amount)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(txn);
    }
  }

  // Pending Uber pre-auth charges (UBR*, UBER TRIP* PENDING): these are real charges.
  // When the ride completes, Discover sends a CONFIRMED email that replaces the pending alert.
  // So if a pending Uber transaction is still in the inbox with no confirmed version,
  // it means the pre-auth IS the actual charge — count it.
  // (If a confirmed version arrives later, it will deduplicate against this entry.)
  const pendingTxns = gmailTransactions.filter((g) => g.pending);
  const confirmedTxns = gmailTransactions.filter((g) => !g.pending);
  if (pendingTxns.length > 0) {
    console.log(`[DEDUP] ${pendingTxns.length} pending Uber pre-auth(s) included as real charges`);
  }
  const allNonDuplicate = [...pendingTxns, ...confirmedTxns];

  for (const gmail of allNonDuplicate) {
    const key = `${gmail.date}-${gmail.merchant}-${Math.abs(gmail.amount)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(gmailToTransaction(gmail));
    }
  }

  return result;
}

/**
 * Format Gmail transactions for Telegram brief
 */
export function formatGmailTransactionsForBrief(
  transactions: GmailTransaction[]
): string {
  if (transactions.length === 0) {
    return `📧 *GMAIL ALERTS*\nNo new Discover alerts.`;
  }

  let output = `📧 *GMAIL ALERTS* (${transactions.length} new)\n\n`;

  for (const txn of transactions) {
    const emoji = Math.abs(txn.amount) > 100 ? "🔴" : "🟡";
    output += `${emoji} ${txn.merchant}: $${Math.abs(txn.amount).toFixed(2)}\n`;
  }

  return output;
}

// === Mock Data ===

export function getMockGmailTransactions(): GmailTransaction[] {
  return [
    {
      id: "gmail-001",
      date: "2026-05-06",
      merchant: "YALLA PITA",
      amount: -14.29,
      rawSubject: "Transaction Alert",
      receivedAt: "2026-05-06T21:22:00Z",
    },
    {
      id: "gmail-002",
      date: "2026-05-05",
      merchant: "UBR* PENDING.UBER.COM",
      amount: -7.39,
      rawSubject: "Transaction Alert",
      receivedAt: "2026-05-05T10:00:00Z",
      pending: true, // May be refunded — excluded from budget
    },
    {
      id: "gmail-003",
      date: "2026-05-05",
      merchant: "UBER TRIP* PENDING",
      amount: -6.23,
      rawSubject: "Transaction Alert",
      receivedAt: "2026-05-05T09:00:00Z",
      pending: true,
    },
    {
      id: "gmail-004",
      date: "2026-05-05",
      merchant: "UBER TRIP* PENDING",
      amount: -8.4,
      rawSubject: "Transaction Alert",
      receivedAt: "2026-05-05T09:00:00Z",
      pending: true,
    },
    {
      id: "gmail-005",
      date: "2026-05-03",
      merchant: "TST*MUMBAI CENTRAL",
      amount: -11.0,
      rawSubject: "Transaction Alert",
      receivedAt: "2026-05-03T14:30:00Z",
    },
  ];
}
