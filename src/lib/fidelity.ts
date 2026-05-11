import * as fs from "fs";
import * as path from "path";
import { MarketData, Position, PortfolioTargets, DriftThresholds, PortfolioStatic } from "./types";
import { getBatchQuotes, calculatePositions, generateRebalanceRecommendations, getMockHoldings } from "./market";
import Imap = require("imap");

const PORTFOLIO_JSON_PATH = "./data/portfolio.json";

// === Types ===

// PortfolioEntry and PortfolioStatic now live in ./types.ts

export interface FidelityAlert {
  type: "transfer" | "trade_confirmation" | "balance_alert";
  subject: string;
  date: string;
  amount?: number;        // For transfer alerts
  balance?: number;       // For balance alert
  ticker?: string;        // For trade confirmations
  shares?: number;         // For trade confirmations
  action?: "BUY" | "SELL"; // For trade confirmations
  rawSnippet: string;
}

export interface BalanceVerification {
  ticker: string;
  agentValue: number;
  fidelityValue: number;
  difference: number;
  withinThreshold: boolean;
}

// === Portfolio Static Ledger ===

/**
 * Load the manually-maintained portfolio.json
 */
export function loadPortfolio(): PortfolioStatic {
  const filePath = path.resolve(PORTFOLIO_JSON_PATH);
  if (!fs.existsSync(filePath)) {
    console.warn("[FIDELITY] portfolio.json not found — using empty portfolio");
    return {
      lastUpdated: new Date().toISOString().split("T")[0],
      note: "Not yet configured",
      positions: {
        VTI: { shares: 0 }, NVDA: { shares: 0 }, VOO: { shares: 0 }, QQQ: { shares: 0 },
        SMH: { shares: 0 }, SCHG: { shares: 0 }, VXUS: { shares: 0 }, SCHD: { shares: 0 },
        SPYD: { shares: 0 }, ASTS: { shares: 0 }, SPAXX: { shares: 0 },
      },
      targetAllocation: {
        VTI: 0.20, NVDA: 0.19, VOO: 0.17, QQQ: 0.14, SMH: 0.10, SCHG: 0.08,
        VXUS: 0.05, SCHD: 0.04, SPYD: 0.01, ASTS: 0.01, SPAXX: 0.01,
      },
    };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as PortfolioStatic;
  } catch {
    console.error("[FIDELITY] Failed to parse portfolio.json");
    throw new Error("Invalid portfolio.json");
  }
}

/**
 * Save portfolio (called when you update share counts)
 */
export function savePortfolio(portfolio: PortfolioStatic): void {
  const filePath = path.resolve(PORTFOLIO_JSON_PATH);
  fs.writeFileSync(filePath, JSON.stringify(portfolio, null, 2));
  console.log(`[FIDELITY] Portfolio saved to ${filePath}`);
}

/**
 * Build holdings Map from portfolio.json
 */
export function getHoldingsFromPortfolio(): Map<string, number> {
  const portfolio = loadPortfolio();
  const holdings = new Map<string, number>();
  for (const [ticker, entry] of Object.entries(portfolio.positions)) {
    // Skip null shares (cash equiv like SPAXX) or explicitly zero-share tickers
    if (entry.shares == null || entry.shares <= 0) continue;
    holdings.set(ticker, entry.shares);
  }
  return holdings;
}

// === Daily Price Sync ===

/**
 * Sync live prices for all tickers in portfolio.json
 * Returns Map of ticker -> MarketData with current prices
 */
export async function syncPrices(): Promise<Map<string, MarketData>> {
  return await getBatchQuotes();
}

/**
 * Calculate portfolio positions using portfolio.json shares + live prices
 */
export async function getFidelityPositions(
  targets: PortfolioTargets,
  thresholds: DriftThresholds
): Promise<Position[]> {
  const holdings = getHoldingsFromPortfolio();
  const quotes = await syncPrices();

  // Calculate total value for weight computation
  let totalValue = 0;
  for (const [ticker, shares] of holdings) {
    const quote = quotes.get(ticker);
    if (!quote) continue;
    totalValue += quote.price * shares;
  }
  // Add 10% cash buffer
  totalValue += 85000 * 0.1;

  const positions: Position[] = [];

  for (const [ticker, shares] of holdings) {
    const quote = quotes.get(ticker);
    if (!quote) continue;

    // Cash equiv like SPAXX — treat as cash (share-count = marketValue in dollars)
    const isCash = shares === null;
    const marketValue = isCash ? quote.price * 1 : quote.price * shares;
    const targetKey = ticker as keyof PortfolioTargets;
    const targetWeight = targets[targetKey] || 0.1;
    const currentWeight = marketValue / totalValue;
    const drift = ((currentWeight - targetWeight) / targetWeight) * 100;

    let status: "on-target" | "drifted" | "black-swan" = "on-target";
    const thresholdKey = ticker as keyof DriftThresholds;
    const driftThreshold = thresholds[thresholdKey] || 5;

    if (Math.abs(quote.changePercent) > 8) {
      status = "black-swan";
    } else if (Math.abs(drift) > driftThreshold) {
      status = "drifted";
    }

    positions.push({
      ticker,
      shares,
      avgCost: 0, // Not tracked in static ledger
      currentPrice: quote.price,
      marketValue,
      dayChange: quote.change * shares,
      dayChangePercent: quote.changePercent,
      weight: currentWeight * 100,
      targetWeight: targetWeight * 100,
      drift,
      status,
    });
  }

  return positions;
}

// === Gmail Alert Scanning ===

/**
 * Parse a Fidelity email body for transfer, trade confirmation, or balance info
 */
function parseFidelityEmail(
  subject: string,
  body: string
): FidelityAlert | null {
  const subjectLower = subject.toLowerCase();
  const bodyLower = body.toLowerCase();

  // Transfer to Fidelity
  if (
    (subjectLower.includes("transfer") || bodyLower.includes("transfer to fidelity")) &&
    bodyLower.includes("$")
  ) {
    const amountMatch = body.match(/\$[\d,]+\.\d{2}/);
    const amount = amountMatch ? parseFloat(amountMatch[0].replace("$", "").replace(",", "")) : undefined;
    return {
      type: "transfer",
      subject,
      date: new Date().toISOString().split("T")[0],
      amount,
      rawSnippet: body.slice(0, 200),
    };
  }

  // Trade Confirmation
  if (subjectLower.includes("trade confirmation") || subjectLower.includes("order filled")) {
    const tickerMatch = body.match(/\b(NVDA|SMH|SCHG)\b/i);
    const sharesMatch = body.match(/(\d+)\s+shares?/i);
    const amountMatch = body.match(/\$[\d,]+\.\d{2}/);
    const action = bodyLower.includes("bought") ? "BUY" : bodyLower.includes("sold") ? "SELL" : undefined;

    return {
      type: "trade_confirmation",
      subject,
      date: new Date().toISOString().split("T")[0],
      amount: amountMatch ? parseFloat(amountMatch[0].replace("$", "").replace(",", "")) : undefined,
      ticker: tickerMatch ? tickerMatch[1].toUpperCase() : undefined,
      shares: sharesMatch ? parseInt(sharesMatch[1]) : undefined,
      action,
      rawSnippet: body.slice(0, 200),
    };
  }

  // Balance Alert
  if (subjectLower.includes("your account balance") || subjectLower.includes("account balance alert")) {
    const balanceMatch = body.match(/\$\s*[\d,]+\.\d{2}/);
    const balance = balanceMatch ? parseFloat(balanceMatch[0].replace("$", "").replace(",", "")) : undefined;
    return {
      type: "balance_alert",
      subject,
      date: new Date().toISOString().split("T")[0],
      balance,
      rawSnippet: body.slice(0, 200),
    };
  }

  return null;
}

/**
 * Scan Gmail for Fidelity emails (transfers, trade confirmations, balance alerts)
 */
export async function scanGmailForFidelityAlerts(
  gmailUser: string,
  gmailAppPassword: string
): Promise<FidelityAlert[]> {
  return new Promise((resolve, reject) => {
    const alerts: FidelityAlert[] = [];

    const Imap = require("imap");
    const imap = new Imap({
      user: gmailUser,
      password: gmailAppPassword,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    function openInbox(cb: (err: Error | null, box?: Imap.Box) => void) {
      imap.openBox("INBOX", true, cb);
    }

    imap.once("ready", () => {
      console.log("[FIDELITY] Connected to Gmail");

      openInbox((err, box) => {
        if (err || !box) {
          imap.end();
          reject(err || new Error("Failed to open inbox"));
          return;
        }

        console.log(`[FIDELITY] Scanning ${box.messages.total} messages for Fidelity alerts...`);

        // Search for Fidelity-related emails (last 30 days worth, or last 500 messages)
        imap.search(
          [
            ["OR",
              ["FROM", "no-reply@email.fidelity.com"],
              ["FROM", "fidelity.com"],
            ],
            ["UNSEEN"],
          ],
          (err: Error | null, results: number[]) => {
            if (err || !results || results.length === 0) {
              console.log("[FIDELITY] No Fidelity emails found");
              imap.end();
              resolve([]);
              return;
            }

            const fetch = imap.fetch(results.slice(-50), {
              bodies: "HEADER.FIELDS (SUBJECT DATE FROM)",
              struct: true,
            });

            const seenIds = new Set<string>();

            fetch.on("message", (msg: Imap.ImapMessage) => {
              let msgSubject = "";
              let msgDate = "";

              msg.on("body", (stream: NodeJS.ReadableStream, info: any) => {
                let buffer = "";
                stream.on("data", (chunk: Buffer) => { buffer += chunk.toString("utf8"); });
                stream.once("end", () => {
                  const fromMatch = buffer.match(/From:[^\n]*/);
                  const subjectMatch = buffer.match(/Subject:[^\n]*/);
                  const dateMatch = buffer.match(/Date:[^\n]*/);
                  if (fromMatch && fromMatch[0].toLowerCase().includes("fidelity")) {
                    msgSubject = subjectMatch ? subjectMatch[0].replace("Subject:", "").trim() : "";
                    msgDate = dateMatch ? dateMatch[0].replace("Date:", "").trim() : "";
                  }
                });
              });

              msg.on("attributes", (attrs: { uid?: number | string }) => {
                const uid = attrs.uid?.toString() ?? Math.random().toString(36);
                if (seenIds.has(uid)) return;
                seenIds.add(uid);

                imap.fetch(attrs.uid, { bodies: "TEXT" }, (err2: Error | null, fetch2: Imap.ImapFetch) => {
                  if (err2) return;
                  fetch2.on("message", (msg2: Imap.ImapMessage) => {
                    let bodyBuffer = "";
                    msg2.on("body", (stream2: NodeJS.ReadableStream) => {
                      stream2.on("data", (chunk2: Buffer) => { bodyBuffer += chunk2.toString("utf8"); });
                      stream2.once("end", () => {
                        const alert = parseFidelityEmail(msgSubject, bodyBuffer);
                        if (alert) {
                          alerts.push(alert);
                        }
                      });
                    });
                  });
                });
              });
            });

            fetch.once("error", (err: Error) => {
              console.error("[FIDELITY] Fetch error:", err);
              imap.end();
              resolve(alerts); // Don't fail the whole scan
            });

            fetch.once("end", () => {
              console.log(`[FIDELITY] Found ${alerts.length} alert(s)`);
              imap.end();
              resolve(alerts);
            });
          }
        );
      });
    });

    imap.once("error", (err: Error) => {
      console.error("[FIDELITY] Gmail connection error:", err.message);
      reject(err);
    });

    imap.connect();
  });
}

// === Balance Verification ===

/**
 * Compare agent's calculated total portfolio value vs Fidelity's stated balance
 */
export async function verifyBalance(
  fidelityStatedBalance: number,
  portfolio: PortfolioStatic,
  targets: PortfolioTargets
): Promise<BalanceVerification[]> {
  const quotes = await syncPrices();
  const results: BalanceVerification[] = [];

  let agentTotal = 0;
  for (const [ticker, entry] of Object.entries(portfolio.positions)) {
    const quote = quotes.get(ticker);
    if (!quote) continue;
    agentTotal += quote.price * entry.shares;
  }

  // Add cash
  const cash = 85000 * 0.1;
  const totalAgentValue = agentTotal + cash;

  const difference = Math.abs(totalAgentValue - fidelityStatedBalance);

  results.push({
    ticker: "PORTFOLIO_TOTAL",
    agentValue: totalAgentValue,
    fidelityValue: fidelityStatedBalance,
    difference,
    withinThreshold: difference <= 10,
  });

  console.log(
    `[FIDELITY] Balance verification: agent=$${totalAgentValue.toFixed(2)} vs fidelity=$${fidelityStatedBalance.toFixed(2)} | diff=$${difference.toFixed(2)}`
  );

  return results;
}

// === Formatting ===

/**
 * Format Fidelity alerts for WhatsApp brief
 */
export function formatFidelityAlerts(alerts: FidelityAlert[]): string {
  if (alerts.length === 0) return "";

  let output = `\n🏦 *FIDELITY ALERTS*\n`;

  for (const alert of alerts) {
    if (alert.type === "transfer") {
      output += `💸 Transfer detected: $${alert.amount?.toFixed(2) ?? "?"}\n`;
      output += `   → Update your portfolio.json share counts\n`;
    } else if (alert.type === "trade_confirmation") {
      const action = alert.action ?? "TRADE";
      const ticker = alert.ticker ?? "?";
      const shares = alert.shares ?? "?";
      output += `📋 ${action} ${shares} ${ticker}: $${alert.amount?.toFixed(2) ?? "?"}\n`;
      output += `   → Confirm share count in portfolio.json\n`;
    } else if (alert.type === "balance_alert") {
      output += `📊 Fidelity Balance: $${alert.balance?.toFixed(2) ?? "?"}\n`;
    }
  }

  return output;
}

/**
 * Format balance verification result for WhatsApp
 */
export function formatBalanceVerification(results: BalanceVerification[]): string {
  if (!results || results.length === 0) return "";

  const top = results[0];
  const emoji = top.withinThreshold ? "✅" : "⚠️";
  let output = `\n${emoji} *BALANCE CHECK*\n`;
  output += `Agent: $${top.agentValue.toFixed(2)}\n`;
  output += `Fidelity: $${top.fidelityValue.toFixed(2)}\n`;
  output += `Diff: $${top.difference.toFixed(2)}`;

  if (!top.withinThreshold) {
    output += `\n⚠️ Difference exceeds $10 — review portfolio.json`;
  }

  return output;
}