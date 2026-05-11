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
 * Format complete brief as Telegram message
 */
export function formatBriefAsTelegram(brief: MorningBrief): string {
  let output = `🌅 *GOOD MORNING — CAPITAL PILOT BRIEF*\n`;
  output += `${brief.date} | 8:00 AM EST\n`;
  output += `${"═".repeat(30)}\n\n`;

  // 1. Liquidity Snapshot
  output += `💵 *LIQUIDITY*\n`;
  const cashStatus = brief.liquidity.status === "surplus" ? "🟢" : "🟡";
  output += `${cashStatus} Cash: $${brief.liquidity.cashAvailable.toLocaleString()}`;
  if (brief.liquidity.cashAvailable < brief.liquidity.cashTarget) {
    output += ` (target: $${brief.liquidity.cashTarget.toLocaleString()})`;
  }
  output += `\n\n`;

  // 2. Budget Pacing
  output += formatBudgetPacingForBrief(brief.budgetPacing);
  output += `\n\n`;

  // 3. Market Summary
  output += `📈 *MARKET*\n`;
  const tickers = ["NVDA", "SMH", "SCHG"];
  for (const ticker of tickers) {
    const pos = brief.portfolioPositions.find((p) => p.ticker === ticker);
    if (!pos) continue;
    
    const emoji = pos.dayChangePercent > 1 ? "🟢" : pos.dayChangePercent < -1 ? "🔴" : "🟡";
    output += `${emoji} ${ticker}: $${pos.currentPrice.toFixed(2)} (${pos.dayChangePercent > 0 ? "+" : ""}${pos.dayChangePercent.toFixed(2)}%)\n`;
  }
  output += `\n`;

  // 4. Portfolio Status
  output += formatPositionsForBrief(brief.portfolioPositions);
  output += `\n`;

  // 4b. Cost of Carry — expense ratio fees
  output += formatCostOfCarry(brief.portfolioPositions);
  output += `
`;

  // 5. Trade Recommendations (if any)
  if (brief.recommendations.length > 0) {
    output += `📋 *TRADE RECOMMENDATIONS*\n`;
    for (const rec of brief.recommendations) {
      const emoji = rec.action === "BUY" ? "🟢" : rec.action === "SELL" ? "🔴" : "🟡";
      output += `${emoji} ${rec.action} ${rec.ticker}`;
      if (rec.shares) output += ` (${rec.shares} shares)`;
      if (rec.dollarAmount) output += ` ($${rec.dollarAmount.toFixed(0)})`;
      output += `\n   ${rec.reason}\n`;
      if (rec.requiresConfirmation) {
        output += `   ⚠️ REQUIRES [CONFIRMED] REPLY\n`;
      }
    }
    output += `\n`;
  }

  // 6. Profit Maximizer
  output += formatProfitMaximizerForBrief(brief.profitMaximizer);
  output += `\n\n`;

  // ═══════════════════════════════════════════
  // DUAL TRACK: SWING SIGNALS + CORE ACCUMULATION
  // ═══════════════════════════════════════════

  // SWING SIGNALS — satellite swing trades (not core holdings)
  const swingPool = (brief as any).swingPool;
  if (swingPool) {
    output += `📊 *SWING POOL*
`;
    output += `Available: $${swingPool.cashAvailable.toFixed(2)} | Realized P&L: ${swingPool.realizedPnL >= 0 ? "+" : ""}$${swingPool.realizedPnL.toFixed(2)}
`;
    output += `Active swings: ${swingPool.positions.length}/2 max\n`;
    if (swingPool.positions.length > 0) {
      for (const pos of swingPool.positions) {
        output += `  📈 ${pos.ticker} | ${pos.signal}
`;
        output += `     Entry: $${pos.entryPrice.toFixed(2)} | Target: $${pos.targetPrice.toFixed(2)} | Stop: $${pos.stopLoss.toFixed(2)}
`;
      }
    } else {
      output += `  (no active swings — deploy when RSI signal fires)\n`;
    }
    output += `\n`;
  }

  // SWING TRADE CALLS — actionable buy/sell for satellite capital
  const topSetups = (brief as any).topSetups;
  if (topSetups && topSetups.length > 0) {
    output += `🎯 *SWING SIGNALS* (satellite capital only — NOT core holdings)\n`;
    output += `_For swing pool: $${swingPool?.cashAvailable?.toFixed(0) ?? 0} available. Max 2 concurrent swings._\n\n`;
    for (const setup of topSetups) {
      const confBar = setup.confidenceScore >= 75 ? "🟢" : setup.confidenceScore >= 55 ? "🟡" : "🔴";
      output += `${confBar} 📈 BUY ${setup.ticker}
`;
      output += `   Entry: $${setup.entryPrice.toFixed(2)} → Target: $${setup.targetPrice.toFixed(2)} | Stop: $${setup.stopLoss.toFixed(2)}
`;
      output += `   R/R: ${setup.riskReward.toFixed(1)}:1 | Profit: $${setup.potentialProfitDollar.toFixed(0)} | Hold: ${setup.holdDaysEstimate}d | Confidence: ${setup.confidenceScore}/100\n`;
      output += `   Because: ${setup.signal.replace(/_/g, " ").toLowerCase()}\n\n`;
    }
  }

  // CORE ACCUMULATION — when to buy VOO/VTI/QQQ
  const coreAccum = (brief as any).coreAccumulation;
  if (coreAccum && coreAccum.length > 0) {
    output += `🏦 *CORE ACCUMULATION SIGNALS*\n`;
    for (const s of coreAccum) {
      const emoji = s.action === "DEFER" ? "⏸" : "✅";
      output += `${emoji} *${s.action} ${s.ticker}* — ${s.reason}\n`;
    }
    output += `\n`;
  } else if (coreAccum && coreAccum.length === 0) {
    output += `🏦 *CORE ACCUMULATION*
  VOO/VTI/QQQ: No signal — RSI not in ideal accumulation zone (55-65) or overextended (>75). Defer until pullback.\n\n`;
  }

  // INVESTOR PERSONA CHECKS
  const invOut = (brief as any).investorOutput;
  if (invOut) {
    if (invOut.buffettLensed.length > 0) {
      output += `🟢 *BUFFETT LENS — passed*
`;
      for (const s of invOut.buffettLensed.slice(0, 2)) {
        output += `  ${s.ticker}: ${s.signal} | $${s.potentialProfitDollar.toFixed(0)} profit | R/R ${s.riskReward.toFixed(1)}:1\n`;
      }
    }
    if (invOut.grahamLensed.length > 0) {
      output += `🟡 *GRAHAM LENS — passed*
`;
      for (const s of invOut.grahamLensed.slice(0, 2)) {
        output += `  ${s.ticker}: ${s.signal} | $${s.potentialProfitDollar.toFixed(0)} profit\n`;
      }
    }
    output += `\n`;
  }

  // 7. Scheduled Actions (require confirmation)
  if (brief.scheduledActions.length > 0) {
    output += `⏳ *PENDING CONFIRMATION*\n`;
    for (const action of brief.scheduledActions) {
      output += `• ${action.description}\n`;
      output += `  Reply [CONFIRMED] to execute\n`;
    }
    output += `\n`;
  }

  // Footer
  output += `${"═".repeat(30)}\n`;
  output += `_Capital Pilot v1.0 | All actions flagged for decision_`;

  return output;
}

/**
 * Determine overall market signal
 */
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

  output += `   ─────────────────
`;
  output += `   Total: $${totalAnnualFee.toFixed(2)}/yr on $${totalValue.toLocaleString()}
`;
  output += `   Effective: ${((totalAnnualFee / totalValue) * 100).toFixed(2)}%
`;

  if (flagged.length > 0) {
    output += `   ⚠️ ${flagged.map(p => p.ticker).join(", ")} > 0.20% ER — review vs performance
`;
  }

  return output;
}