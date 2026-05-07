import { Transaction } from "./types";
import Imap = require("imap");

const GMAIL_IMAP_HOST = "imap.gmail.com";
const GMAIL_IMAP_PORT = 993;

/**
 * Gmail Transaction Parser
 *
 * Scans Gmail inbox for Discover transaction alerts.
 *
 * Actual email format (from discover@services.discover.com):
 *   Subject: "Transaction Alert"
 *   Body (key fields):
 *     Merchant: YALLA PITA
 *     Date: May 06, 2026
 *     Amount: $14.29
 *
 * Supports both field-label format (actual) and the old sentence format (legacy).
 */
export interface GmailTransaction {
  id: string;
  date: string;
  merchant: string;
  amount: number;
  rawSubject: string;
  receivedAt: string;
}

/**
 * Parse Gmail transaction alert email body.
 * Supports two formats:
 *
 * Format A — Field-label (actual Discover email):
 *   Merchant: YALLA PITA
 *   Date: May 06, 2026
 *   Amount: $14.29
 *
 * Format B — Legacy sentence (fallback):
 *   "Your Discover card was used for $45.00 at UBER EATS PIZZA on 05/03/2026."
 */
function parseTransactionEmail(body: string): GmailTransaction | null {
  let merchant: string | undefined;
  let dateStr: string | undefined;
  let amount: number | undefined;

  // ── Format A: Field-label format ──────────────────────────────────────────
  const merchantMatch = body.match(/^Merchant:\s*(.+)$/m);
  const dateMatch = body.match(/^Date:\s*(.+)$/m);
  const amountMatch = body.match(/^Amount:\s*\$([\d,]+(?:\.\d{2})?)/m);

  if (merchantMatch) merchant = merchantMatch[1].trim().toUpperCase();
  if (amountMatch) amount = parseFloat(amountMatch[1].replace(",", ""));

  if (dateMatch) {
    const raw = dateMatch[1].trim(); // e.g. "May 06, 2026"
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
      dateStr = parsed.toISOString().split("T")[0]; // "2026-05-06"
    }
  }

  // ── Format B: Legacy sentence format (fallback) ─────────────────────────
  if (!merchant || !dateStr || amount === undefined) {
    const bAmountMatch = body.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    const bMerchantMatch = body.match(/(?:at|for)\s+([A-Z][A-Za-z\s]+?)(?:\s+on|\s+\")/i);
    const bDateMatch = body.match(/(\d{2}\/\d{2}\/\d{4})/);

    if (!amount && bAmountMatch) {
      amount = parseFloat(bAmountMatch[1].replace(",", ""));
    }
    if (!merchant && bMerchantMatch) {
      merchant = bMerchantMatch[1].trim().toUpperCase();
    }
    if (!dateStr && bDateMatch) {
      dateStr = bDateMatch[1].replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$1-$2");
    }
  }

  if (!merchant || amount === undefined) return null;
  if (!dateStr) dateStr = new Date().toISOString().split("T")[0];

  const id = `gmail-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  return {
    id,
    date: dateStr,
    merchant,
    amount: -amount, // Negative for purchases
    rawSubject: "Transaction Alert",
    receivedAt: new Date().toISOString(),
  };
}

/**
 * Scan Gmail inbox for Discover transaction alerts
 *
 * Requires: GMAIL_APP_PASSWORD env var
 * Returns: Array of transactions found
 *
 * Searches both discover@services.discover.com and service@email.discover.com
 * to cover any sender address changes Discover may make.
 */
export async function scanGmailForDiscoverAlerts(
  gmailUser: string,
  gmailAppPassword: string
): Promise<GmailTransaction[]> {
  return new Promise((resolve, reject) => {
    const transactions: GmailTransaction[] = [];

    console.log(`[GMAIL] Connecting to ${GMAIL_IMAP_HOST}:${GMAIL_IMAP_PORT} as ${gmailUser}`);

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
      console.log("[GMAIL] Connected successfully");

      openInbox((err, box) => {
        if (err || !box) {
          console.error("[GMAIL] Failed to open inbox:", err);
          imap.end();
          reject(err || new Error("Failed to open inbox"));
          return;
        }

        console.log(`[GMAIL] Scanning ${box.messages.total} messages for Discover alerts...`);

        // Search for last 10 transaction alerts
        // Matches both sender addresses Discover uses
        imap.search(
          [
            ["FROM", "discover@services.discover.com"],
            ["OR", ["FROM", "service@email.discover.com"]],
            ["SUBJECT", "Transaction Alert"],
            ["UNSEEN"],
          ],
          (err: Error | null, results: number[]) => {
            if (err) {
              console.error("[GMAIL] Search failed:", err);
              imap.end();
              reject(err);
              return;
            }

            if (results.length === 0) {
              console.log("[GMAIL] No new Discover alerts found");
              imap.end();
              resolve([]);
              return;
            }

            console.log(`[GMAIL] Found ${results.length} new alerts`);

            const fetch = imap.fetch(results.slice(-10), {
              bodies: "TEXT",
              struct: true,
            });

            fetch.on("message", (msg) => {
              msg.on("body", (stream) => {
                let buffer = "";
                stream.on("data", (chunk) => {
                  buffer += chunk.toString("utf8");
                });
                stream.once("end", () => {
                  const txn = parseTransactionEmail(buffer);
                  if (txn) {
                    transactions.push(txn);
                  }
                });
              });
            });

            fetch.once("error", (err: Error) => {
              console.error("[GMAIL] Fetch error:", err);
              imap.end();
              reject(err);
            });

            fetch.once("end", () => {
              console.log(`[GMAIL] Parsed ${transactions.length} transactions`);
              imap.end();
              resolve(transactions);
            });
          }
        );
      });
    });

    imap.once("error", (err: Error) => {
      console.error("[GMAIL] Connection error:", err.message);
      reject(err);
    });

    imap.connect();
  });
}

/**
 * Convert Gmail transactions to standard Transaction format
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
 * Expanded to cover more merchant patterns for better categorization.
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
  if (lower.includes("zelle") || lower.includes("rent") || lower.includes("venmo")) {
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
 * Deduplicate transactions from CSV and Gmail
 *
 * Priority: CSV wins if duplicate found (CSV is audited record)
 * Returns: Combined unique transactions
 */
export function deduplicateTransactions(
  csvTransactions: Transaction[],
  gmailTransactions: GmailTransaction[]
): Transaction[] {
  const seen = new Set<string>();

  // First add CSV transactions (higher priority - audited record)
  const result: Transaction[] = [];

  for (const txn of csvTransactions) {
    const key = `${txn.date}-${txn.merchant}-${Math.abs(txn.amount)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(txn);
    } else {
      console.log(`[DEDUP] Skipping CSV duplicate: ${txn.merchant} ${txn.amount}`);
    }
  }

  // Then add Gmail transactions that aren't duplicates
  for (const gmail of gmailTransactions) {
    const key = `${gmail.date}-${gmail.merchant}-${Math.abs(gmail.amount)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(gmailToTransaction(gmail));
      console.log(`[DEDUP] Added Gmail transaction: ${gmail.merchant}`);
    } else {
      console.log(`[DEDUP] Skipping Gmail duplicate: ${gmail.merchant}`);
    }
  }

  return result;
}

/**
 * Format Gmail transactions as readable text
 */
export function formatGmailTransactionsForBrief(
  transactions: GmailTransaction[]
): string {
  if (transactions.length === 0) {
    return `📧 *GMAIL ALERTS*\nNo new Discover alerts.`;
  }

  let output = `📧 *GMAIL ALERTS* (${transactions.length} new)\n\n`;

  for (const txn of transactions) {
    const emoji = txn.amount < -100 ? "🔴" : "🟡";
    output += `${emoji} ${txn.merchant}: $${Math.abs(txn.amount).toFixed(2)}\n`;
  }

  return output;
}

// === Mock Data for Testing ===

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
      date: "2026-05-03",
      merchant: "UBER EATS",
      amount: -45.5,
      rawSubject: "Transaction Alert",
      receivedAt: "2026-05-03T14:30:00Z",
    },
  ];
}
