/**
 * Market Opportunity Scanner v4 — runs every 30 min.
 * Only alerts when there is EVIDENCE-BASED rationale for action.
 * No mechanical rules like "down 8% = buy the dip."
 *
 * Philosophy: A stock dropping 10% in isolation tells you nothing.
 * A stock dropping 10% while the broader market is flat tells you something is wrong WITH THIS STOCK.
 * A stock dropping 10% alongside a sector-wide rotation tells you the DIP is real.
 *
 * v4 ADDITION: 38-ticker watchlist scanner — comprehensive entry/exit signals.
 *   BUY signals:  RSI oversold bounce, pullback to support, MA50 reclaim
 *   SELL signals: Sell-the-rip (overbought + extended), extended no-entry
 *   Only actionable alerts — no "HOLD" noise.
 */

import { getBatchQuotes, getSectorQuotes, getMacroQuotes, getWatchlistQuotes, calculatePositions } from "./market";
import { getHoldingsFromPortfolio } from "./fidelity";
import {
  BLACK_SWAN_THRESHOLD_PCT,
  rankSetups,
  generateTradeSetups,
  generateMomentumAlerts,
  generateEntrySignals,
} from "./recommendations";

import * as fs from "fs";
import * as path from "path";

// ── Peak Alert Persistence ─────────────────────────────────────────────────────
// Track which tickers have fired PEAK_ZONE so we can later identify PULLBACK_ENTRY.
// Persisted to disk so it survives across scanner runs (not just in-memory).
const PEAK_ALERTS_FILE = "./data/peak-alerts.json";

function loadPeakAlerts(): Set<string> {
  const filePath = path.resolve(PEAK_ALERTS_FILE);
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // Filter out alerts older than 30 days — peak memory fades
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const valid = (data.tickers as Array<{ticker: string; ts: number}>)
      .filter(e => e.ts > cutoff);
    return new Set(valid.map(e => e.ticker));
  } catch {
    return new Set();
  }
}

function savePeakAlerts(tickers: Set<string>): void {
  const filePath = path.resolve(PEAK_ALERTS_FILE);
  const data = {
    ts: Date.now(),
    tickers: Array.from(tickers).map(t => ({ ticker: t, ts: Date.now() })),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ── Market Context ────────────────────────────────────────────────────────────

interface MarketContext {
  marketChange: number;
  sectorChange: number;
  isBroadSelloff: boolean;
  isSectorRotation: boolean;
}

function assessMarketContext(portfolioQuotes: Map<string, any>, sectorQuotes: Map<string, any>): MarketContext {
  const spy = portfolioQuotes.get("SPY");
  const qqq = portfolioQuotes.get("QQQ");
  const smh = sectorQuotes.get("SMH");
  const marketChange = spy?.changePercent ?? qqq?.changePercent ?? 0;
  const sectorChange = smh?.changePercent ?? marketChange;
  const isBroadSelloff = marketChange < -2;
  const isSectorRotation = Math.abs(sectorChange - marketChange) > 2;
  return { marketChange, sectorChange, isBroadSelloff, isSectorRotation };
}

interface DipAssessment {
  rationale: string;
  riskNote: string;
  confidence: "high" | "medium" | "low";
}

function assessDipBuy(ticker: string, tickerChange: number, context: MarketContext, quote: any): DipAssessment {
  const { marketChange, sectorChange, isBroadSelloff } = context;

  // CASE 1: Isolated collapse — stock dropping but market is flat or up
  if (marketChange > -1 && tickerChange < -8) {
    return {
      rationale: `${ticker} down ${Math.abs(tickerChange).toFixed(1)}% but market (SPY) is ${marketChange > 0 ? "up" : "only down " + marketChange.toFixed(1)}%. Stock collapsing in isolation — likely company-specific problem.`,
      riskNote: "Isolated drops often precede further declines. No catalyst identified for recovery. Falling knife risk HIGH.",
      confidence: "low",
    };
  }

  // CASE 2: Broad market selloff — market is down >2%
  if (isBroadSelloff) {
    const relativeStrength = tickerChange - marketChange;
    if (relativeStrength < -3) {
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

  // CASE 3: Sector rotation
  if (context.isSectorRotation && tickerChange < -6) {
    if (sectorChange < marketChange - 2) {
      if (quote.rsi <= 40) {
        return {
          rationale: `Sector rotation driving ${ticker} down ${Math.abs(tickerChange).toFixed(1)}%. SMH (sector ETF) down ${Math.abs(sectorChange).toFixed(1)}%, market down ${Math.abs(Number(marketChange.toFixed(1)))}%. Rotation not company-specific — sector-wide positioning.`,
          riskNote: "Sector rotations can reverse quickly. Watch for sector ETF stabilization before committing.",
          confidence: "medium",
        };
      }
    }
  }

  // CASE 4: No clear macro/sector context
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

interface TakeProfitAssessment {
  rationale: string;
  riskNote: string;
  confidence: "high" | "medium" | "low";
}

function assessTakeProfit(ticker: string, tickerChange: number, context: MarketContext, quote: any): TakeProfitAssessment {
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

  // CASE 3: Strong move with no earnings catalyst
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

// ── Core Scanner ──────────────────────────────────────────────────────────────

export interface Opportunity {
  type: string;
  severity: "critical" | "high" | "medium";
  ticker: string;
  message: string;
  action: string;
  rationale: string;
  riskNote: string;
  details: string;
  confidenceScore?: number;
}

export async function scanForOpportunities(): Promise<Opportunity[]> {
  // Fetch all four quote groups in parallel — Yahoo Finance is I/O-bound, batching helps
  const [portfolioQuotes, sectorQuotes, macroQuotes, watchlistQuotes, holdings] = await Promise.all([
    getBatchQuotes(),
    getSectorQuotes(),
    getMacroQuotes(),
    getWatchlistQuotes(),
    getHoldingsFromPortfolio(),
  ]);

  const allQuotes = new Map([...portfolioQuotes, ...sectorQuotes, ...watchlistQuotes]);
  const positions = calculatePositions(portfolioQuotes, holdings);
  const portfolioValue = positions.reduce((sum, p) => sum + p.marketValue, 0) || 45648.95;
  const fullQuoteMap = new Map([...portfolioQuotes, ...sectorQuotes, ...macroQuotes, ...watchlistQuotes]);

  const marketContext = assessMarketContext(portfolioQuotes, sectorQuotes);
  const opportunities: Opportunity[] = [];

  // ── 1. Portfolio Black Swan ────────────────────────────────────────────
  for (const pos of positions) {
    const move = Math.abs(pos.dayChangePercent);
    if (move <= BLACK_SWAN_THRESHOLD_PCT) continue;
    const quote = fullQuoteMap.get(pos.ticker);
    if (!quote) continue;

    if (pos.dayChangePercent < 0) {
      const dip = assessDipBuy(pos.ticker, pos.dayChangePercent, marketContext, {
        rsi: quote.rsi ?? 50,
        ma20: quote.ma20 ?? quote.price,
        ma50: quote.ma50 ?? quote.price,
        price: quote.price,
      });
      if (dip.confidence === "low") {
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
      const tp = assessTakeProfit(pos.ticker, pos.dayChangePercent, marketContext, {
        rsi: quote.rsi ?? 50,
        price: quote.price,
        ma20: quote.ma20 ?? quote.price,
        ma50: quote.ma50 ?? quote.price,
      });
      if (tp.confidence === "low") continue;
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

  // ── 2. Trade Setups ────────────────────────────────────────────────────
  const setups = rankSetups(
    Array.from(allQuotes.values())
      .flatMap(q => generateTradeSetups(q, portfolioValue))
  ).slice(0, 5);

  for (const setup of setups) {
    if (setup.confidence !== "high") continue;
    if (setup.potentialProfitDollar < 1500) continue;
    opportunities.push({
      type: "setup",
      severity: "high",
      ticker: setup.ticker,
      message: `🟢 ${setup.ticker} — ${setup.signal.replace(/_/g, " ")}`,
      action: `BUY TARGET $${setup.targetPrice.toFixed(2)}`,
      rationale: `R/R ${setup.riskReward.toFixed(1)}:1 | Profit: $${setup.potentialProfitDollar.toFixed(0)} | Hold: ${setup.holdDaysEstimate}d | ${setup.catalyst}`,
      riskNote: `Stop at $${setup.stopLoss.toFixed(2)} (${((setup.entryPrice - setup.stopLoss) / setup.entryPrice * 100).toFixed(1)}% risk).`,
      details: `Entry: $${setup.entryPrice.toFixed(2)} → Target: $${setup.targetPrice.toFixed(2)} | Stop: $${setup.stopLoss.toFixed(2)} | R/R: ${setup.riskReward.toFixed(1)}:1`,
    });
  }

  // ── 3. MOMENTUM EXTENDED Alerts — Three-Tier Peak Detection ─────────────
  const heldPeakAlerts = loadPeakAlerts();
  const portfolioTickerSet = new Set((holdings || new Map()).keys());
  // Track which tickers fire in THIS scan — prevents the same ticker from
  // appearing twice (PEAK_ZONE + PULLBACK_ENTRY) in one run. PULLBACK_ENTRY
  // takes priority since it's the higher-conviction signal.
  const seenThisScan = new Set<string>();

  const momentumAlerts = generateMomentumAlerts(fullQuoteMap, portfolioTickerSet, heldPeakAlerts);

  for (const alert of momentumAlerts) {
    // Skip if already handled in this scan (PULLBACK_ENTRY wins over PEAK_ZONE)
    if (seenThisScan.has(alert.ticker)) continue;

    opportunities.push({
      type: alert.type,
      severity: alert.severity,
      ticker: alert.ticker,
      message: alert.message,
      action: alert.action,
      rationale: alert.rationale,
      riskNote: alert.riskNote,
      details: alert.details,
      confidenceScore: alert.confidenceScore,
    });
    seenThisScan.add(alert.ticker);

    if (alert.type === "momentum-peak") {
      heldPeakAlerts.add(alert.ticker);
    } else if (alert.type === "momentum-peak-entry") {
      // Ticker has now pulled back — remove from peak tracking so this
      // alert doesn't fire again. It will re-arm if/when price re-extends.
      heldPeakAlerts.delete(alert.ticker);
    }
  }

  if (heldPeakAlerts.size > 0) {
    savePeakAlerts(heldPeakAlerts);
  } else {
    // No active peaks — clean up stale file
    try {
      const filePath = path.resolve(PEAK_ALERTS_FILE);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* non-fatal */ }
  }

  // ── 4. WATCHLIST ENTRY SIGNALS — 38 Tickers, 9 Sectors ─────────────────
  // watchlistQuotes already fetched above in parallel with everything else
  // Generate buy/sell signals for the full watchlist
  const entrySignals = generateEntrySignals(watchlistQuotes, portfolioTickerSet);

  for (const sig of entrySignals) {
    // Only show critical/high — medium watchlist signals are informational only
    if (sig.severity === "medium") continue;
    // Skip tickers already handled as PEAK_ZONE this scan to avoid duplicate alerts
    if (seenThisScan.has(sig.ticker)) continue;
    seenThisScan.add(sig.ticker);

    opportunities.push({
      type: sig.type,
      severity: sig.severity,
      ticker: sig.ticker,
      message: sig.message,
      action: sig.action,
      rationale: sig.rationale,
      riskNote: sig.riskNote,
      details: sig.details,
      confidenceScore: sig.confidenceScore,
    });
  }

  return opportunities;
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatOpportunityAlert(opps: Opportunity[]): string {
  if (opps.length === 0) return "";

  // Separate opportunities into output sections
  const buys = opps.filter(o =>
    o.action.startsWith("BUY") || o.action.includes("PULLBACK ENTRY")
  );
  const sells = opps.filter(o =>
    o.action.startsWith("TRIM") || o.action.startsWith("SELL")
  );
  const peakNoChase = opps.filter(o =>
    (o.action.includes("DON'T BUY") || o.action.includes("DON'T CHASE") || o.action.includes("WAIT"))
    && !o.action.startsWith("BUY") && !o.action.startsWith("TRIM") && !o.action.startsWith("SELL")
  );

  // If nothing actionable (no buys, no trims, no pullbacks), stay silent
  if (buys.length === 0 && sells.length === 0) {
    return ""; // scanner will output "no alerts meet evidence threshold"
  }

  const timestamp = new Date().toLocaleString("en-US", {
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

  let output = `🚨 *MARKET ALERT* — ${timestamp}\n`;
  output += `_38-ticker watchlist | Evidence-based only | No mechanical rules_\n\n`;

  // Section 1: BUY THE DIP
  if (buys.length > 0) {
    output += `📈 *BUY THE DIP* (${buys.length} signal${buys.length > 1 ? "s" : ""})\n`;
    for (const opp of buys) {
      const conf = opp.severity === "critical" ? "🚨" : "🟡";
      output += `${conf} *${opp.ticker}* — ${opp.action}`;
      output += ` [${Math.round(opp.confidenceScore ?? 50)}/100]
`;
      output += `   ${opp.rationale}\n`;
      output += `   ⚠️ ${opp.riskNote}\n`;
      output += `   📊 ${opp.details}\n\n`;
    }
  }

  // Section 2: TRIM THE RIP
  if (sells.length > 0) {
    output += `✂️ *TRIM THE RIP* (${sells.length} signal${sells.length > 1 ? "s" : ""})\n`;
    for (const opp of sells) {
      const conf = opp.severity === "critical" ? "🚨" : "🟡";
      output += `${conf} *${opp.ticker}* — ${opp.action}`;
      output += ` [${Math.round(opp.confidenceScore ?? 50)}/100]
`;
      output += `   ${opp.rationale}\n`;
      output += `   ⚠️ ${opp.riskNote}\n`;
      output += `   📊 ${opp.details}\n\n`;
    }
  }

  // Optional: peek at what's extended but not actionable yet
  const extended = peakNoChase.filter(o =>
    o.type === "momentum-peak" || o.type === "sell-the-rip" || o.type === "momentum-extended"
  );
  if (extended.length > 0) {
    const tickers = extended.slice(0, 8).map(o => o.ticker).join(", ");
    output += `🔭 *EXTENDED + ON RADAR* — ${tickers}${extended.length > 8 ? ` +${extended.length - 8} more` : ""}\n`;
    output += `_Peak zone / extended — don't chase. Will alert on pullback._\n\n`;
  }

  output += `_Reply BUY / SELL / WATCH / IGNORE to act._`;
  return output;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
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
  })();
}