import { 
  MorningBrief, 
  BriefSection, 
  BudgetPacingReport, 
  MarketData, 
  Position, 
  TradeRecommendation, 
  ProfitMaximizerIdea 
} from "./types";
import { formatBudgetPacingForBrief } from "./budget";
import { formatMarketSummary, formatPositionsForBrief } from "./market";
import { formatProfitMaximizerForBrief } from "./profitMaximizer";

/**
 * Compose the full Morning Brief
 */
export function composeBrief(
  budgetPacing: BudgetPacingReport,
  quotes: Map<string, MarketData>,
  positions: Position[],
  recommendations: TradeRecommendation[],
  profitMaximizer: ProfitMaximizerIdea[],
  cashAvailable: number = 85000 * 0.1
): MorningBrief {
  const now = new Date();
  
  const marketSummary = formatMarketSummary(quotes);
  const biggestMover = marketSummary.biggestMover;

  return {
    date: now.toISOString().split("T")[0],
    liquidity: {
      cashAvailable,
      cashTarget: 85000 * 0.1, // 10% of $850k portfolio
      status: cashAvailable > 8500 ? "surplus" : "balanced",
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
 * Format complete brief as WhatsApp message
 */
export function formatBriefAsWhatsApp(brief: MorningBrief): string {
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