import { 
  MorningBrief, 
  BriefSection, 
  BudgetPacingReport, 
  MarketData,
  computeFeeDrag, 
  Position, 
  TradeRecommendation, 
  ProfitMaximizerIdea 
} from "./types";
import { formatBudgetPacingForBrief } from "./budget";
import { formatMarketSummary, formatPositionsForBrief } from "./market";
import { formatProfitMaximizerForBrief } from "./profitMaximizer";
import { formatDiscoverySummary, computeDiscoveryConfidence, loadQueue } from "./market_discovery";
import { SwingState } from "./swing_manager";
import { InvestorOutput } from "./investor_filter";

/**
 * Compose the full Morning Brief
 */
export function composeBrief(
  budgetPacing: BudgetPacingReport,
  quotes: Map<string, MarketData>,
  positions: Position[],
  recommendations: TradeRecommendation[],
  profitMaximizer: ProfitMaximizerIdea[],
  swingPoolCash: number,
  topSetups: any[],
  swingState: SwingState,
  coreAccumSignals: { ticker: string; action: string; reason: string }[],
  investorOutput: InvestorOutput,
  cashAvailable: number = 591.74
): MorningBrief {
  const now = new Date();
  
  const marketSummary = formatMarketSummary(quotes);
  const biggestMover = marketSummary.biggestMover;

  return {
    date: now.toISOString().split("T")[0],
    liquidity: {
      cashAvailable,
      cashTarget: 5917.42 * 0.1,
      status: cashAvailable > 5917.42 * 0.1 ? "surplus" : "balanced",
    },
    budgetPacing,
    marketSummary: {
      overnightShift: biggestMover.change > 2 
        ? `${biggestMover.ticker} up ${biggestMover.change.toFixed(1)}% overnight` 
        : "No major overnight moves",
      biggestMover,
      overallSignal: determineOverallSignal(quotes),
    },
    portfolioPositions: positions,
    recommendations,
    profitMaximizer,
    swingPool: {
      cashAvailable: swingPoolCash,
      positions: swingState.positions,
      realizedPnL: swingState.realizedPnL,
    },
    coreAccumulation: coreAccumSignals,
    investorOutput,
    scheduledActions: recommendations
      .filter((r) => r.requiresConfirmation)
      .map((r) => ({
        type: r.type,
        description: `${r.action} ${r.ticker}${r.shares ? ` (${r.shares} shares)` : ""} — ${r.reason}`,
        requiresConfirmation: true,
      })),
  };
}

/**
 * Format complete brief as Telegram message — single-pass, no duplication.
 */
export function formatBriefAsTelegram(brief: MorningBrief): string {
  // ── 1. HEADER ─────────────────────────────────────────────────────────────
  let output = `🌅 *GOOD MORNING — CAPITAL PILOT BRIEF*\n`;
  output += `${brief.date} | 8:00 AM EST\n`;
  output += `${"═".repeat(30)}\n\n`;

  // ── 2. LIQUIDITY ─────────────────────────────────────────────────────────────
  output += `💵 *LIQUIDITY*\n`;
  const cashStatus = brief.liquidity.status === "surplus" ? "🟢" : "🟡";
  output += `${cashStatus} Cash: $${brief.liquidity.cashAvailable.toLocaleString()}`;
  if (brief.liquidity.cashAvailable < brief.liquidity.cashTarget) {
    output += ` (target: $${brief.liquidity.cashTarget.toLocaleString()})`;
  }
  output += `\n\n`;

  // ── 3. BUDGET PACING ────────────────────────────────────────────────────────
  output += formatBudgetPacingForBrief(brief.budgetPacing);
  output += `\n\n`;

  // ── 4. MARKET + RSI SNAPSHOT ──────────────────────────────────────────────────
  output += `📈 *MARKET*\n`;
  const rsiTickers = ["NVDA", "QQQ", "SMH", "VOO"];
  for (const ticker of rsiTickers) {
    const pos = brief.portfolioPositions.find((p) => p.ticker === ticker);
    if (!pos) continue;
    const emoji = pos.dayChangePercent > 1 ? "🟢" : pos.dayChangePercent < -1 ? "🔴" : "🟡";
    const signal = pos.rsi != null && pos.rsi > 80 ? "OVERBOUGHT ⚠️" : pos.rsi != null && pos.rsi > 70 ? "OVERBOUGHT" : pos.rsi != null && pos.rsi > 65 ? "ELEVATED" : pos.rsi != null && pos.rsi > 55 ? "NEUTRAL" : "MODERATE";
    output += `${emoji} ${ticker}: $${pos.currentPrice.toFixed(2)} (${pos.dayChangePercent > 0 ? "+" : ""}${pos.dayChangePercent.toFixed(2)}%) | RSI ${pos.rsi?.toFixed(1) ?? "—"} — ${signal}\n`;
  }
  output += `\n`;

  // ── 5. PORTFOLIO ─────────────────────────────────────────────────────────────
  output += `💼 *PORTFOLIO*\n`;
  for (const pos of brief.portfolioPositions) {
    const statusEmoji = pos.status === "black-swan" ? "⚠️" : pos.status === "drifted" ? "🔄" : "✅";
    const driftSign = pos.drift > 0 ? "+" : "";
    if (Math.abs(pos.drift) > 5) {
      output += `${statusEmoji} ${pos.ticker}: $${pos.marketValue.toFixed(0)} (${pos.weight.toFixed(1)}%) 📉 ${driftSign}${pos.drift.toFixed(1)}% | $${pos.currentPrice.toFixed(2)}\n`;
    } else {
      output += `✅ ${pos.ticker}: $${pos.marketValue.toFixed(0)} (${pos.weight.toFixed(1)}%) | $${pos.currentPrice.toFixed(2)}\n`;
    }
  }
  output += `\n`;

  // ── 6. REBALANCE ACTIONS (drift-based, not market-timing) ──────────────────
  const buys = brief.recommendations.filter((r) => r.action === "BUY");
  const sells = brief.recommendations.filter((r) => r.action === "SELL");
  const holds = brief.recommendations.filter((r) => r.action === "HOLD");

  if (buys.length > 0) {
    output += `✅ *BUY — REBALANCE INTO UNDERWEIGHT*\n`;
    output += `_Drift-based. Ignores short-term RSI. Check RSI column above before acting.\n`;
    output += `_Confidence: 🟢 high  🟡 medium  🔴 low.\n`;
    for (const rec of buys) {
      const pos = brief.portfolioPositions.find(p => p.ticker === rec.ticker);
      const currentShares = pos?.shares ?? 0;
      const targetShares = pos ? Math.round(((pos.targetWeight / 100) * brief.portfolioPositions.reduce((s, p) => s + p.marketValue, 0)) / pos.currentPrice) : 0;
      const confBadge = rec.confidence === "high" ? "🟢" : rec.confidence === "medium" ? "🟡" : "🔴";
      const confScore = rec.confidence === "high" ? 78 : rec.confidence === "medium" ? 65 : 48;
      const dollars = rec.dollarAmount ? `$${rec.dollarAmount.toFixed(0)}` : "?";
      const sharesToTarget = targetShares > currentShares ? `(+${(targetShares - currentShares).toFixed(0)} to target)` : "";
      output += `${confBadge} | BUY  ${rec.ticker} | +${rec.shares} shares (~${dollars}) | Have ${currentShares.toFixed(0)} → Target ${targetShares.toFixed(0)} ${sharesToTarget}  [${confScore}/100]\n`;
    }
    output += `\n`;
  }
  if (sells.length > 0) {
    output += `🔴 *SELL / TRIM — REBALANCE OUT OF OVERWEIGHT*\n`;
    output += `_Drift-based. Ignores short-term RSI. Confidence per rec shown below.\n`;
    for (const rec of sells) {
      const pos = brief.portfolioPositions.find(p => p.ticker === rec.ticker);
      const currentShares = pos?.shares ?? 0;
      const targetShares = pos ? Math.round(((pos.targetWeight / 100) * brief.portfolioPositions.reduce((s, p) => s + p.marketValue, 0)) / pos.currentPrice) : 0;
      const confBadge = rec.confidence === "high" ? "🟢" : rec.confidence === "medium" ? "🟡" : "🔴";
      const confScore = rec.confidence === "high" ? 78 : rec.confidence === "medium" ? 65 : 48;
      const proceeds = rec.dollarAmount ? `$${rec.dollarAmount.toFixed(0)}` : "?";
      const sharesToTarget = targetShares < currentShares ? `(-${(currentShares - targetShares).toFixed(0)} to target)` : "";
      output += `${confBadge} | SELL ${rec.ticker} | -${rec.shares} shares (~${proceeds}) | Have ${currentShares.toFixed(0)} → Target ${targetShares.toFixed(0)} ${sharesToTarget}  [${confScore}/100]\n`;
    }
    output += `\n`;
  }
  if (holds.length > 0) {
    output += `⏸ *HOLD / DEFER*\n`;
    for (const rec of holds) {
      const pos = brief.portfolioPositions.find(p => p.ticker === rec.ticker);
      const currentShares = pos?.shares ?? 0;
      const confScore = 62;
      output += `🟡 | ${rec.ticker} | ${currentShares.toFixed(3)} shares | ${rec.reason}  [${confScore}/100]\n`;
    }
    output += `\n`;
  }

  // ── 7. PROFIT MAXIMIZER (RSI-oversold sector bounces) ─────────────────────
  // BUY XLE/VHT on RSI oversold — satellite/momentum trade, NOT core rebalance.
  // Confidence: 🟢 high / 🟡 medium / 🔴 low. R/R ratio = risk/reward.
  output += formatProfitMaximizerForBrief(brief.profitMaximizer);
  output += `\n\n`;

  // ── 8. CORE ACCUMULATION (when to add to VOO/VTI/QQQ) ────────────────────────
  // ACCUMULATE = RSI in 55-65 sweet spot (good entry for core holdings).
  // DEFER = RSI > 70 (overextended) — wait for pullback below 70.
  // Orthogonal to Profit Maximizer: Core Accum = ADDING to core portfolio.
  // Profit Maximizer = SATELLITE momentum trades (different capital).
  const coreAccum = (brief as any).coreAccumulation;
  if (coreAccum && coreAccum.length > 0) {
    output += `🏦 *CORE ACCUMULATION SIGNALS*\n`;
    for (const s of coreAccum) {
      const emoji = s.action === "DEFER" ? "⏸" : "✅";
      output += `${emoji} *${s.action} ${s.ticker}* — ${s.reason}\n`;
    }
    output += `\n`;
  }

  // ── 9. PENDING CONFIRMATION ─────────────────────────────────────────────────
  if (brief.scheduledActions.length > 0) {
    output += `⏳ *PENDING CONFIRMATION*\n`;
    for (const action of brief.scheduledActions) {
      output += `• ${action.description}\n`;
      output += `  Reply [CONFIRMED] to execute\n`;
    }
    output += `\n`;
  }

  // ── 10. MARKET DISCOVERY (new opportunities outside portfolio) ─────────────
  const discoverySummary = formatDiscoverySummary();
  if (discoverySummary) {
    output += discoverySummary;
    output += `\n`;
  }

  // ── 11. CONSOLIDATED DECISION SUMMARY ─────────────────────────────────────
  output += `📋 *DECISION SUMMARY* — All Calls\n`;
  output += `"${"─".repeat(35)}\n`;

  // REBALANCE
  const rebalanceBuys = brief.recommendations.filter(r => r.action === "BUY");
  const rebalanceSells = brief.recommendations.filter(r => r.action === "SELL");
  const cashEquivalents = new Set(["SPAXX", "VNAXX", "FZFXX", "FGTXX"]);
  const filteredRebalanceBuys = rebalanceBuys.filter(r => !cashEquivalents.has(r.ticker));
  const filteredRebalanceSells = rebalanceSells.filter(r => !cashEquivalents.has(r.ticker));
  if (filteredRebalanceBuys.length > 0 || filteredRebalanceSells.length > 0) {
    output += `🔄 *REBALANCE*\n`;
    for (const r of filteredRebalanceBuys) {
      const confScore = r.confidence === "high" ? 78 : r.confidence === "medium" ? 65 : 48;
      const confLabel = confScore >= 70 ? "🟢" : confScore >= 55 ? "🟡" : "🔴";
      output += `  ${confLabel} BUY  ${r.ticker.padEnd(6)} +${r.shares ?? "?"} shares (~$${r.dollarAmount?.toFixed(0) ?? "?"})  conf: ${confScore}/100\n`;
    }
    for (const r of filteredRebalanceSells) {
      const confScore = r.confidence === "high" ? 78 : r.confidence === "medium" ? 65 : 48;
      const confLabel = confScore >= 70 ? "🟢" : confScore >= 55 ? "🟡" : "🔴";
      output += `  ${confLabel} SELL ${r.ticker.padEnd(6)} -${r.shares ?? "?"} shares (~$${r.dollarAmount?.toFixed(0) ?? "?"})  conf: ${confScore}/100\n`;
    }
    output += `\n`;
  }

  // PROFIT MAXIMIZER
  if (brief.profitMaximizer && brief.profitMaximizer.length > 0) {
    output += `🚀 *PROFIT MAXIMIZER* (swing pool)\n`;
    for (const pm of brief.profitMaximizer) {
      const rr = (pm as any).riskRewardRatio ?? (pm as any).riskReward ?? 0;
      const confScore = rr >= 0.8 ? 72 : rr >= 0.5 ? 63 : 45;
      const confLabel = confScore >= 70 ? "🟢" : confScore >= 55 ? "🟡" : "🔴";
      output += `  ${confLabel} BUY  ${pm.ticker.padEnd(6)} entry: $${pm.entryPrice?.toFixed(2)}  R/R: ${rr.toFixed(1)}:1  conf: ${confScore}/100\n`;
    }
    output += `\n`;
  }

  // CORE ACCUMULATION
  if (coreAccum && coreAccum.length > 0) {
    output += `🏦 *CORE ACCUMULATION*\n`;
    for (const s of coreAccum) {
      const isBuy = s.action === "ACCUMULATE";
      const confScore = isBuy ? 70 : 62;
      output += `  ${isBuy ? "🟢" : "🟡"} ${s.action.padEnd(12)} ${s.ticker.padEnd(6)} — ${s.reason.split(" — ")[0] ?? s.reason}  conf: ${confScore}/100\n`;
    }
    output += `\n`;
  }

  // SWING POOL
  const swingPositions = (brief as any).swingPool?.positions as any[] | undefined;
  if (swingPositions && swingPositions.length > 0) {
    output += `💹 *SWING POOL* (active)\n`;
    for (const sp of swingPositions) {
      const entryPrice = (sp as any).entryPrice ?? sp.currentPrice ?? 0;
      const currentPrice = (sp as any).currentPrice ?? sp.currentPrice ?? entryPrice;
      const shares = sp.shares ?? (sp as any).shares ?? 0;
      const pnl = (currentPrice - entryPrice) * shares;
      const confScore = (sp as any).confidenceScore ?? 68;
      const confLabel = confScore >= 70 ? "🟢" : confScore >= 55 ? "🟡" : "🔴";
      const pnlSign = pnl >= 0 ? "+" : "";
      output += `  ${confLabel} HOLD ${sp.ticker.padEnd(6)} ${shares} shares  PnL: ${pnlSign}$${pnl.toFixed(2)}  conf: ${confScore}/100\n`;
    }
    output += `\n`;
  }

  // DISCOVERY
  const discQueue = loadQueue();
  const newDiscEntries = discQueue.entries
    .filter((e: any) => e.status === "new")
    .sort((a: any, b: any) => {
      const order: Record<string, number> = { "BUY": 0, "SELL": 1, "HOLD": 2 };
      return (order[a.signal] ?? 9) - (order[b.signal] ?? 9);
    });
  if (newDiscEntries.length > 0) {
    output += `🔍 *DISCOVERY*\n`;
    for (const d of newDiscEntries) {
      const confScore = computeDiscoveryConfidence(d as any);
      const confLabel = confScore >= 70 ? "🟢" : confScore >= 55 ? "🟡" : "🔴";
      const sigLabel = d.signal === "BUY" ? "BUY " : d.signal === "SELL" ? "SELL" : "HOLD";
      const pricePos = d.pctOf52wHi > 95 ? "near 52w high" : d.pctOf52wHi < 50 ? "near 52w low" : `${d.pctOf52wHi.toFixed(0)}% of 52w`;
      output += `  ${confLabel} ${sigLabel} ${d.ticker.padEnd(6)} RSI ${(d as any).rsi?.toFixed(0)} | ${pricePos}  conf: ${confScore}/100\n`;
    }
    output += `\n`;
  }

  output += `"${"─".repeat(35)}\n`;
  output += `_Confidence: 🟢 70+  🟡 55-69  🔴 <55_\n\n`;

  // ── FOOTER ──────────────────────────────────────────────────────────────────
  output += `${"═".repeat(30)}\n`;
  output += `_Capital Pilot v1.0 | All actions flagged for decision_`;

  return output;
}

function determineOverallSignal(quotes: Map<string, MarketData>): "bull" | "bear" | "neutral" {
  const signals = Array.from(quotes.values()).map((q) => q.status);
  const bullCount = signals.filter((s) => s === "bull").length;
  const bearCount = signals.filter((s) => s === "bear").length;

  if (bullCount > bearCount) return "bull";
  if (bearCount > bullCount) return "bear";
  return "neutral";
}

/**
 * Check if brief has any high-priority items
 */
export function hasHighPriorityItems(brief: MorningBrief): boolean {
  if (brief.scheduledActions.length > 0) return true;
  if (brief.recommendations.some((r) => r.type === "black-swan")) return true;
  if (brief.budgetPacing.categories.some((c) => c.status === "exceeded")) return true;
  return false;
}

/**
 * Extract action items that require confirmation
 */
export function extractActionItems(brief: MorningBrief): string[] {
  return brief.scheduledActions.map((a) => a.description);
}

/**
 * Format Cost of Carry section — annual fee drag from expense ratios.
 * Flags positions with ER > 0.20% with contextual note (not rejection).
 * SMH at 0.35% is fine if semi thesis is delivering — flag for awareness.
 */
export function formatCostOfCarry(positions: any[]): string {
  const withFees = positions
    .map(p => ({ ...p, ...computeFeeDrag(p.marketValue, p.ticker) }))
    .filter(p => p.er > 0 && p.annualFee > 0);

  if (withFees.length === 0) return "";

  const totalAnnualFee = withFees.reduce((sum, p) => sum + p.annualFee, 0);
  const totalValue = withFees.reduce((sum, p) => sum + p.marketValue, 0);
  const flagged = withFees.filter(p => p.flagged);

  let output = `💸 *COST OF CARRY* — Annual fee drag
`;

  for (const p of withFees) {
    const erPct = (p.er * 100).toFixed(2);
    const flag = p.flagged ? " ⚠️" : "";
    output += `   ${p.ticker}: $${p.annualFee.toFixed(2)}/yr (${erPct}% ER)${flag}
`;
  }

  const effRate = totalValue > 0 ? (totalAnnualFee / totalValue * 100).toFixed(2) : "0.00";
  output += `   ─────────────────
   Total: $${totalAnnualFee.toFixed(2)}/yr on $${totalValue.toFixed(0)}
   Effective: ${effRate}%
`;
  if (flagged.length > 0) {
    const names = flagged.map((p) => p.ticker).join(", ");
    output += `   ⚠️ ${names} > 0.20% ER — review vs performance
`;
  }

  return output + `\n`;
}
