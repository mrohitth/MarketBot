/**
 * Market Opportunity Scanner v2 — runs every 2 hours.
 * Only alerts when there is EVIDENCE-BASED rationale for action.
 * No mechanical rules like "down 8% = buy the dip."
 *
 * Philosophy: A stock dropping 10% in isolation tells you nothing.
 * A stock dropping 10% while the broader market is flat tells you something is wrong WITH THIS STOCK.
 * A stock dropping 10% alongside a sector-wide rotation tells you the DIP is real.
 */

import { getBatchQuotes, getSectorQuotes, getMacroQuotes } from "./market";
import { getHoldingsFromPortfolio, loadPortfolio } from "./fidelity";
import { calculatePositions } from "./market";
import {
  generateTradeSetups,
  rankSetups,
  BLACK_SWAN_THRESHOLD_PCT,
  TradeSetup,
} from "./recommendations";

const PORTFOLIO_VALUE = 45648.95; // Updated from real Fidelity screenshot May 7 2026

interface Opportunity {
  type: "black-swan-up" | "black-swan-down" | "setup" | "sector-rotation" | "earnings-momentum";
  severity: "critical" | "high" | "medium";
  ticker: string;
  message: string;
  action: string;
  rationale: string; // THE EVIDENCE — why this alert is warranted
  riskNote: string; // What could go wrong if you act on this
  details: string;
}

interface MarketContext {
  marketChange: number; // SPY/QQQ change — the "temperature" of the market
  sectorChange: number; // SMH or sector ETF change — sector direction
  isBroadSelloff: boolean; // marketChange < -2%
  isSectorRotation: boolean; // sectorChange significantly differs from market
}

/**
 * Assess market context: how is the broad market and sector performing?
 * This determines whether a stock's move is isolated or part of a broader shift.
 */
function assessMarketContext(
  portfolioQuotes: Map<string, { changePercent: number }>,
  sectorQuotes: Map<string, { changePercent: number }>
): MarketContext {
  const spy = portfolioQuotes.get("SPY");
  const qqq = portfolioQuotes.get("QQQ");
  const smh = sectorQuotes.get("SMH");

  const marketChange = spy?.changePercent ?? qqq?.changePercent ?? 0;
  const sectorChange = smh?.changePercent ?? marketChange;

  const isBroadSelloff = marketChange < -2;
  const isSectorRotation = Math.abs(sectorChange - marketChange) > 2;

  return { marketChange, sectorChange, isBroadSelloff, isSectorRotation };
}

/**
 * Determine if a DOWN move is a legitimate dip-buy or a falling knife.
 * Returns a rationale string and a severity.
 */
function assessDipBuy(
  ticker: string,
  tickerChange: number,
  context: MarketContext,
  quote: { rsi: number; ma20: number; ma50: number; price: number }
): { rationale: string; riskNote: string; confidence: "high" | "medium" | "low" } {
  const { marketChange, sectorChange, isBroadSelloff } = context;

  // CASE 1: Isolated collapse — stock dropping but market is flat or up
  // → This is a falling knife. Do NOT buy.
  if (marketChange > -1 && tickerChange < -8) {
    return {
      rationale: `${ticker} down ${Math.abs(tickerChange).toFixed(1)}% but market (SPY) is ${marketChange > 0 ? "up" : "only down " + marketChange.toFixed(1)}%. Stock collapsing in isolation — likely company-specific problem.`,
      riskNote: "Isolated drops often precede further declines. No catalyst identified for recovery. Falling knife risk HIGH.",
      confidence: "low",
    };
  }

  // CASE 2: Broad market selloff — market is down >2%
  // → Dip is legitimate — macro-driven, not company-specific
  if (isBroadSelloff) {
    const relativeStrength = tickerChange - marketChange;
    if (relativeStrength < -3) {
      // Stock is dropping FASTER than the market — may have company-specific problem
      return {
        rationale: `${ticker} down ${Math.abs(tickerChange).toFixed(1)}% (market down ${Math.abs(marketChange).toFixed(1)}%). Stock underperforming sector — possible company-specific issue.`,
        riskNote: "Stock falling faster than peers even in a broad selloff. Could have hidden problem. Proceed with caution.",
        confidence: "low",
      };
    }
    if (quote.rsi <= 35) {
      return {
        rationale: `${ticker} down ${Math.abs(tickerChange).toFixed(1)}% in broad market selloff. RSI oversold at ${quote.rsi.toFixed(0)}. Market-wide dip — historically high-probability bounce entry.`,
        riskNote: "Broad selloffs can extend. Hold stop at -5% from entry. Do not average down blindly.",
        confidence: "high",
      };
    }
    return {
      rationale: `${ticker} down ${Math.abs(tickerChange).toFixed(1)}% in broad market selloff. Dip is macro-driven, not isolated to this stock.`,
      riskNote: "Market selloffs can continue. RSI not yet oversold. Wait for confirmation.",
      confidence: "medium",
    };
  }

  // CASE 3: Sector rotation — sector significantly under/outperforming market
  if (context.isSectorRotation && tickerChange < -6) {
    if (sectorChange < marketChange - 2) {
      // Sector is getting hammered — stock is catching the rotation
      if (quote.rsi <= 40) {
        return {
          rationale: `Sector rotation driving ${ticker} down ${Math.abs(tickerChange).toFixed(1)}%. SMH (sector ETF) down ${Math.abs(sectorChange).toFixed(1)}%, market down ${Math.abs(marketChange).toFixed(1)}%. Rotation not company-specific — sector-wide positioning.`,
          riskNote: "Sector rotations can reverse quickly. Watch for sector ETF stabilization before committing.",
          confidence: "medium",
        };
      }
    }
  }

  // CASE 4: No clear macro/sector context — use technicals
  if (quote.rsi <= 35) {
    return {
      rationale: `${ticker} RSI oversold at ${quote.rsi.toFixed(0)} — historically leads to bounce. No clear macro/sector headwind identified. Technical bounce candidate.`,
      riskNote: "Oversold can stay oversold. Use stop loss. No fundamental catalyst confirmed.",
      confidence: "medium",
    };
  }

  return {
    rationale: `${ticker} down ${Math.abs(tickerChange).toFixed(1)}% but no clear macro/sector catalyst and RSI not oversold. Not enough evidence to buy the dip.`,
    riskNote: "No confirmed catalyst. Could be pre-cursor to further decline. Wait for more evidence.",
    confidence: "low",
  };
}

/**
 * Determine if an UP move warrants a take-profit alert.
 */
function assessTakeProfit(
  ticker: string,
  tickerChange: number,
  context: MarketContext,
  quote: { rsi: number; price: number; ma20: number; ma50: number }
): { rationale: string; riskNote: string; confidence: "high" | "medium" | "low" } {
  const { marketChange } = context;

  // CASE 1: Short squeeze — stock up big, market flat or down
  if (tickerChange > 8 && marketChange < 1) {
    return {
      rationale: `${ticker} up ${tickerChange.toFixed(1)}% but market is ${marketChange > 0 ? "barely up" : "down"}. Price moving on thin volume or short covering — not fundamentals. HIGH REVERSAL RISK.`,
      riskNote: "Short squeezes reverse hard. This looks like a technical spike, not a fundamental move. Taking profit here is wise.",
      confidence: "high",
    };
  }

  // CASE 2: RSI overbought
  if (quote.rsi >= 68) {
    return {
      rationale: `${ticker} up ${tickerChange.toFixed(1)}% with RSI at ${quote.rsi.toFixed(0)} (overbought). Extended rally — pullback likely. Consider taking profit.`,
      riskNote: "Overbought can mean extended. Hold if you have high conviction, but trim if position is large.",
      confidence: "medium",
    };
  }

  // CASE 3: Earnings-adjacent or news catalyst
  // We don't have earnings dates in scope, so flag as "no catalyst confirmed"
  if (tickerChange > 8 && quote.rsi < 65) {
    return {
      rationale: `${ticker} up ${tickerChange.toFixed(1)}% — strong move. No earnings or fundamental catalyst confirmed in data. Could be momentum.`,
      riskNote: "Momentum can continue. If you have conviction, hold. If this is a position you bought cheap, consider locking in partial profits.",
      confidence: "medium",
    };
  }

  return {
    rationale: `${ticker} up ${tickerChange.toFixed(1)}%. Move is within normal variation. No take-profit signal triggered.`,
    riskNote: "Normal market movement. No action warranted.",
    confidence: "low",
  };
}

export async function scanForOpportunities(): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];

  const [portfolioQuotes, sectorQuotes, macroQuotes, holdings] = await Promise.all([
    getBatchQuotes(),
    getSectorQuotes(),
    getMacroQuotes(),
    Promise.resolve(getHoldingsFromPortfolio()),
  ]);

  const allQuotes = new Map([...portfolioQuotes, ...sectorQuotes]);
  const positions = calculatePositions(portfolioQuotes, holdings);
  const portfolioValue =
    positions.reduce((sum: number, p: { marketValue: number }) => sum + p.marketValue, 0) || PORTFOLIO_VALUE;

  // Combine all quotes into one map for context assessment
  const fullQuoteMap = new Map([...portfolioQuotes, ...sectorQuotes, ...macroQuotes]);

  // Assess broad market context
  const marketContext = assessMarketContext(portfolioQuotes, sectorQuotes);

  // ── 1. Portfolio Black Swan — EVIDENCE-BASED ────────────────────────────
  for (const pos of positions) {
    const move = Math.abs(pos.dayChangePercent);
    if (move <= BLACK_SWAN_THRESHOLD_PCT) continue;

    const quote = fullQuoteMap.get(pos.ticker);
    if (!quote) continue;

    if (pos.dayChangePercent < 0) {
      // Stock is DOWN — assess dip quality
      const dip = assessDipBuy(pos.ticker, pos.dayChangePercent, marketContext, {
        rsi: quote.rsi ?? 50,
        ma20: quote.ma20 ?? quote.price,
        ma50: quote.ma50 ?? quote.price,
        price: quote.price,
      });

      if (dip.confidence === "low") {
        // Don't alert — falling knife or not enough evidence
        console.log(`[SCANNER] ${pos.ticker} DOWN ${Math.abs(pos.dayChangePercent).toFixed(1)}% — ${dip.rationale}`);
        continue;
      }

      opportunities.push({
        type: "black-swan-down",
        severity: dip.confidence === "high" ? "critical" : "high",
        ticker: pos.ticker,
        message: `🔴 ${pos.ticker} DOWN ${Math.abs(pos.dayChangePercent).toFixed(1)}%`,
        action: dip.confidence === "high" ? "BUY THE DIP?" : "WATCH — UNCONFIRMED DIP",
        rationale: dip.rationale,
        riskNote: dip.riskNote,
        details: `$${pos.marketValue.toFixed(0)} position (${pos.shares} shares). Market: ${marketContext.marketChange.toFixed(1)}% | Sector: ${marketContext.sectorChange.toFixed(1)}% | RSI: ${quote.rsi?.toFixed(0) ?? "N/A"}`,
      });
    } else {
      // Stock is UP — assess take-profit quality
      const tp = assessTakeProfit(pos.ticker, pos.dayChangePercent, marketContext, {
        rsi: quote.rsi ?? 50,
        price: quote.price,
        ma20: quote.ma20 ?? quote.price,
        ma50: quote.ma50 ?? quote.price,
      });

      if (tp.confidence === "low") continue; // No alert needed for normal up move

      opportunities.push({
        type: "black-swan-up",
        severity: tp.confidence === "high" ? "critical" : "high",
        ticker: pos.ticker,
        message: `🟢 ${pos.ticker} UP ${pos.dayChangePercent.toFixed(1)}%`,
        action: tp.confidence === "high" ? "TAKE PROFIT?" : "MONITOR — EXTENDED",
        rationale: tp.rationale,
        riskNote: tp.riskNote,
        details: `$${pos.marketValue.toFixed(0)} position (${pos.shares} shares). Market: ${marketContext.marketChange.toFixed(1)}% | Sector: ${marketContext.sectorChange.toFixed(1)}% | RSI: ${quote.rsi?.toFixed(0) ?? "N/A"}`,
      });
    }
  }

  // ── 2. High-Confidence Trade Setups (non-portfolio) ────────────────────
  const setups = rankSetups(
    Array.from(allQuotes.values())
      .flatMap((q) => generateTradeSetups(q, portfolioValue))
  ).slice(0, 5);

  for (const setup of setups) {
    if (setup.confidence !== "high") continue;
    if (setup.potentialProfitDollar < 1500) continue; // Only interrupt for 1.5x minimum

    opportunities.push({
      type: "setup",
      severity: "high",
      ticker: setup.ticker,
      message: `🟢 ${setup.ticker} — ${setup.signal.replace(/_/g, " ")}`,
      action: `BUY TARGET $${setup.targetPrice.toFixed(2)}`,
      rationale: `R/R ${setup.riskReward.toFixed(1)}:1 | Profit: $${setup.potentialProfitDollar.toFixed(0)} | Hold: ${setup.holdDaysEstimate}d | ${setup.catalyst}`,
      riskNote: `Stop at $${setup.stopLoss.toFixed(2)} (${((setup.entryPrice - setup.stopLoss) / setup.entryPrice * 100).toFixed(1)}% risk). Max loss: $${(setup.stopLoss - setup.entryPrice * setup.riskReward).toFixed(0) || "TBD"}.`,
      details: `Entry: $${setup.entryPrice.toFixed(2)} → Target: $${setup.targetPrice.toFixed(2)} | Stop: $${setup.stopLoss.toFixed(2)} | R/R: ${setup.riskReward.toFixed(1)}:1`,
    });
  }

  return opportunities;
}

export function formatOpportunityAlert(opps: Opportunity[]): string {
  if (opps.length === 0) return "";

  let output = `🚨 *MARKET ALERT* — ${new Date().toLocaleString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}\n`;
  output += `_Evidence-based only. No mechanical rules._\n\n`;

  for (const opp of opps) {
    const sev = opp.severity === "critical" ? "🚨" : "🟡";
    output += `${sev} *${opp.ticker}*\n`;
    output += `${opp.message}\n`;
    output += `→ Action: *${opp.action}*\n`;
    output += `📋 Rationale: ${opp.rationale}\n`;
    output += `⚠️ Risk: ${opp.riskNote}\n`;
    output += `${opp.details}\n\n`;
  }

  output += `_Reply BUY / SELL / WATCH / IGNORE to act._`;
  return output;
}

// CLI
async function main() {
  try {
    const opps = await scanForOpportunities();
    const alertText = formatOpportunityAlert(opps);
    if (alertText) {
      console.log(alertText);
    } else {
      console.log(`[SCANNER] ${new Date().toISOString()} — no alerts meet evidence threshold`);
    }
  } catch (error) {
    console.error("[SCANNER] Error:", error);
  }
}

if (require.main === module) {
  main();
}

export { PORTFOLIO_VALUE };