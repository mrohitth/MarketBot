/**
 * Market Opportunity Scanner — runs every 2 hours to catch pre/post-market moves.
 * Only interrupts Mathew for high-priority opportunities. Quiet the rest.
 */

import * as fs from "fs";
import * as path from "path";
import { getBatchQuotes, getSectorQuotes } from "./market";
import { getHoldingsFromPortfolio, loadPortfolio } from "./fidelity";
import { calculatePositions } from "./market";
import { generateTradeSetups, rankSetups, BLACK_SWAN_THRESHOLD_PCT } from "./recommendations";

const PORTFOLIO_VALUE = 45648.95; // Updated from real Fidelity screenshot May 7 2026

const ALERT_CONFIG = {
  minProfitDollar: 1000,
  minRiskReward: 2.0,
  blackSwanThreshold: BLACK_SWAN_THRESHOLD_PCT, // 8%
} as const;

interface Opportunity {
  type: "black-swan" | "setup" | "breakout" | "earnings" | "gap-fill";
  severity: "critical" | "high" | "medium";
  ticker: string;
  message: string;
  action: string;
  details: string;
}

export async function scanForOpportunities(): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];

  const [quotes, sectorQuotes, holdings, portfolio] = await Promise.all([
    getBatchQuotes(),
    getSectorQuotes(),
    Promise.resolve(getHoldingsFromPortfolio()),
    Promise.resolve(loadPortfolio()),
  ]);

  const allQuotes = new Map([...quotes, ...sectorQuotes]);
  const positions = calculatePositions(quotes, holdings);
  const portfolioValue =
    positions.reduce((sum: number, p: { marketValue: number }) => sum + p.marketValue, 0) || PORTFOLIO_VALUE;

  // ── 1. Portfolio Black Swan Check ─────────────────────────────────────────
  for (const pos of positions) {
    const move = Math.abs(pos.dayChangePercent);
    if (move > BLACK_SWAN_THRESHOLD_PCT) {
      const direction = pos.dayChangePercent > 0 ? "up" : "down";
      const emoji = pos.dayChangePercent > 0 ? "🟢" : "🔴";
      opportunities.push({
        type: "black-swan",
        severity: "critical",
        ticker: pos.ticker,
        message: `${emoji} ${pos.ticker} ${direction} ${pos.dayChangePercent.toFixed(1)}% — BLACK SWAN`,
        action: pos.dayChangePercent > 0 ? "TAKE PROFIT?" : "BUY THE DIP?",
        details: `$${pos.marketValue.toFixed(0)} position (${pos.shares} shares). Move of ${move.toFixed(1)}% exceeds ${BLACK_SWAN_THRESHOLD_PCT}% threshold. ${pos.dayChangePercent < 0 ? "May be buying opportunity." : "Consider taking profit."}`,
      });
    }
  }

  // ── 2. High-Confidence Trade Setups ──────────────────────────────────────
  const setups = rankSetups(
    Array.from(allQuotes.values())
      .flatMap((q) => generateTradeSetups(q, portfolioValue))
  ).slice(0, 5);

  for (const setup of setups) {
    if (setup.confidence !== "high") continue;
    if (setup.potentialProfitDollar < ALERT_CONFIG.minProfitDollar * 1.5) continue; // Only interrupt for 1.5x minimum
    opportunities.push({
      type: "setup",
      severity: "high",
      ticker: setup.ticker,
      message: `🟢 ${setup.ticker} — ${setup.signal.replace(/_/g, " ")}`,
      action: `BUY TARGET $${setup.targetPrice.toFixed(2)}`,
      details: `Entry: $${setup.entryPrice.toFixed(2)} → Target: $${setup.targetPrice.toFixed(2)} | Stop: $${setup.stopLoss.toFixed(2)} | R/R: ${setup.riskReward.toFixed(1)}:1 | Profit: $${setup.potentialProfitDollar.toFixed(0)} | Hold: ${setup.holdDaysEstimate}d | ${setup.catalyst}`,
    });
  }

  // ── 3. Sector Gap Fill / Earnings Momentum ────────────────────────────────
  for (const [ticker, quote] of sectorQuotes) {
    const portfolioTicker = [...quotes.keys()].some((k) => k === ticker);
    if (portfolioTicker) continue; // skip portfolio holdings in sector scan

    // RSI overbought with breakout — check for gap fill opportunity
    if (quote.changePercent > 4 && quote.rsi > 65) {
      opportunities.push({
        type: "gap-fill",
        severity: "medium",
        ticker,
        message: `📊 ${ticker} +${quote.changePercent.toFixed(1)}% (gap up)`,
        action: "WATCH — RSI OVERBOUGHT",
        details: `RSI=${quote.rsi.toFixed(0)}, price=${quote.price.toFixed(2)}. May be extended. Watch for pullback entry.`,
      });
    }

    // Earnings-adjacent momentum (RSI in sweet spot, strong volume)
    if (quote.rsi >= 40 && quote.rsi <= 55 && quote.volume > quote.volumeAvg * 1.8) {
      const posSize = Math.floor(portfolioValue * 0.01 / quote.price);
      const profit = (quote.price * 1.04 - quote.price) * posSize;
      if (profit >= 800) {
        opportunities.push({
          type: "earnings",
          severity: "medium",
          ticker,
          message: `📈 ${ticker} — volume surge + ${(quote.volume / quote.volumeAvg * 100).toFixed(0)}% avg vol`,
          action: `BUILDING — RSI ${quote.rsi.toFixed(0)}`,
          details: `Price: $${quote.price.toFixed(2)} | Vol: ${(quote.volume / quote.volumeAvg * 100).toFixed(0)}% of avg | RSI: ${quote.rsi.toFixed(0)} | Target +4% in 5 days`,
        });
      }
    }
  }

  return opportunities;
}

export function formatOpportunityAlert(opps: Opportunity[]): string {
  if (opps.length === 0) return "";

  let output = `🚨 *MARKET ALERT* — ${new Date().toLocaleString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}\n\n`;

  for (const opp of opps) {
    const severityPrefix =
      opp.severity === "critical" ? "🚨" : opp.severity === "high" ? "🟢" : "📊";
    output += `${severityPrefix} *${opp.ticker}*\n`;
    output += `${opp.message}\n`;
    output += `Action: ${opp.action}\n`;
    output += `${opp.details}\n\n`;
  }

  output += `_Reply BUY / SELL / WATCH to act, or IGNORE to dismiss._`;
  return output;
}

// CLI runner for cron
async function main() {
  try {
    const opps = await scanForOpportunities();
    const alertText = formatOpportunityAlert(opps);
    if (alertText) {
      console.log(alertText);
    } else {
      console.log(`[OPPORTUNITY SCAN] ${new Date().toISOString()} — no alerts triggered`);
    }
  } catch (error) {
    console.error("[OPPORTUNITY SCAN] Error:", error);
  }
}

if (require.main === module) {
  main();
}

export { ALERT_CONFIG };