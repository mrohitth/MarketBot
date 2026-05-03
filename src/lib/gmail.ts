import { Transaction } from "./types";
import Imap = require("imap");

const GMAIL_IMAP_HOST = "imap.gmail.com";
const GMAIL_IMAP_PORT = 993;

/**
 * Gmail Transaction Parser
 *
 * Scans Gmail inbox for Discover transaction alerts.
 * Format expected:
 * - From: service@email.discover.com
 * - Subject: "Transaction Alert"
 * - Body contains: merchant name, amount, date
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
 * Parse Gmail transaction alert email body
 * Example format:
 * "Your Discover card was used for $45.00 at UBER EATS PIZZA on 05/03/2026."
 */
function parseTransactionEmail(body: string): GmailTransaction | null {
  // Extract amount
  const amountMatch = body.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1].replace(",", ""));

  // Extract merchant (usually after "at" or "for")
  const merchantMatch = body.match(/(?:at|for)\s+([A-Z][A-Za-z\s]+?)(?:\s+on|\s+\d)/i);
  const merchant = merchantMatch ? merchantMatch[1].trim() : "Unknown";

  // Extract date from body
  const dateMatch = body.match(/(\d{2}\/\d{2}\/\d{4})/);
  const date = dateMatch
    ? dateMatch[1].replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$1-$2")
    : new Date().toISOString().split("T")[0];

  const id = `gmail-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  return {
    id,
    date,
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
        imap.search(
          [
            ["FROM", "service@email.discover.com"],
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
 * Map merchant name to Discover category
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
    lower.includes("food")
  ) {
    return "Dining";
  }
  if (lower.includes("amazon") || lower.includes("target") || lower.includes("shop")) {
    return "Discretionary";
  }
  if (lower.includes("zelle") || lower.includes("rent")) {
    return "Housing";
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
      date: "2026-05-03",
      merchant: "UBER EATS",
      amount: -45.5,
      rawSubject: "Transaction Alert - Your Discover Card was used",
      receivedAt: "2026-05-03T14:30:00Z",
    },
    {
      id: "gmail-002",
      date: "2026-05-02",
      merchant: "STARBUCKS",
      amount: -8.75,
      rawSubject: "Transaction Alert - Your Discover Card was used",
      receivedAt: "2026-05-02T09:15:00Z",
    },
  ];
}