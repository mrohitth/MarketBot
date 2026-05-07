/**
 * investor_filter.ts — Apply Buffett and Graham investor persona lenses to trade setups.
 *
 * Implemented as pure algorithmic scoring (no LLM needed at runtime) — deterministic,
 * fast, no external dependencies. This is Phase 1 of the investor persona integration.
 *
 * Phase 2 (future): wire in LLM for full Buffett/Graham natural-language reasoning
 * by pre-running a sub-agent that outputs structured scores before the daily brief.
 *
 * Buffett criteria (10-year hold test, moat, fair price, compounding):
 *   +15 to +20: Core holding (NVDA, VOO, VTI, QQQ, SMH) + strong technical setup
 *   +5 to +14:  Index ETF or established semi with valid setup
 *   -5 to +4:   Non-core single name with moderate setup
 *   -20 to -6:  Speculative (ASTS <$15M market cap) or failed moat test
 *
 * Graham criteria (margin of safety, deep value, dividend support, defensive sizing):
 *   +15 to +20: Strong margin of safety (entry 15%+ below intrinsic) + dividend
 *   +5 to +14:  Reasonable margin of safety, established business
 *   -5 to +4:   Limited margin of safety, higher-risk name
 *   -20 to -6:  No margin of safety or speculative position
 */

import { TradeSetup } from "./recommendations";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PersonaResult {
  ticker: string;
  signal: string;
  buffettDelta: number;       // -20 to +20
  buffettReasoning: string;
  grahamDelta: number;         // -20 to +20
  grahamReasoning: string;
  passesFilter: boolean;
  filterFailReason?: string;
}

export interface InvestorFilterOutput {
  buffettLensed: TradeSetup[];
  grahamLensed: TradeSetup[];
  rejected: PersonaResult[];
  summary: string;
}

// ── Persona Classification ────────────────────────────────────────────────────

type ConvictionLevel = "core" | "satellite" | "tactical" | "speculative";

function getConvictionLevel(ticker: string): ConvictionLevel {
  // Core: broad indices — Buffett's ideal 10-year holds
  if (["VTI", "VOO", "QQQ"].includes(ticker)) return "core";
  // Satellite: established semis and growth ETFs
  if (["NVDA", "SMH", "SCHG", "SCHD"].includes(ticker)) return "satellite";
  // Tactical: sector/macro tilts with shorter horizon
  if (["VXUS", "SPYD"].includes(ticker)) return "tactical";
  // Speculative: single-name moonshots
  if (["ASTS"].includes(ticker)) return "speculative";
  return "satellite";
}

function getIntrinsicValueEstimate(ticker: string, price: number): number {
  // Rough intrinsic value estimates based on known fundamentals.
  // These should be updated periodically — this is a static baseline.
  switch (ticker) {
    case "VTI": return price * 1.05;   // Broad market tracks intrinsic closely
    case "VOO": return price * 1.05;   // S&P500 — similar to VTI
    case "QQQ": return price * 0.95;   // Tech premium — slightly overvalued at fair
    case "NVDA": return price * 1.15;  // AI infrastructure moat = above-market growth
    case "SMH": return price * 1.05;   // Semi ETF — tracks underlying semis
    case "SCHG": return price * 1.10;  // Growth factor — long-term premium warranted
    case "SCHD": return price * 1.15;  // Dividend stability = defensive moat
    case "VXUS": return price * 1.05;  // International — neutral
    case "SPYD": return price * 1.10; // High dividend yield — income = intrinsic buffer
    case "ASTS": return price * 0.70;  // Pre-revenue satellite — deep uncertainty discoun
    default: return price;
  }
}

function hasMoat(ticker: string): boolean {
  // Known moats based on Mathew's research
  const moatTickers = ["NVDA", "VTI", "VOO", "QQQ", "SMH", "SCHG", "SCHD"];
  return moatTickers.includes(ticker);
}

function isDividendPayer(ticker: string): boolean {
  const dividendTickers = ["VTI", "VOO", "QQQ", "SCHG", "SCHD", "VXUS", "SPYD"];
  return dividendTickers.includes(ticker);
}

// ── Buffett Lens ─────────────────────────────────────────────────────────────

function scoreBuffett(setup: TradeSetup): { delta: number; reasoning: string; passes: boolean } {
  const ticker = setup.ticker;
  const price = setup.entryPrice;
  const conviction = getConvictionLevel(ticker);
  const moat = hasMoat(ticker);
  const rsi = (setup as any).rsi ?? 50;
  const conf = setup.confidenceScore;

  // Step 1: Conviction classification drives baseline delta
  let delta: number;
  let reasoning: string;

  if (conviction === "core") {
    delta = 15;
    reasoning = `${ticker} is a core 10-year hold (VTI/VOO/QQQ). Buffett would not sell this.`;
  } else if (conviction === "satellite") {
    delta = 8;
    reasoning = `${ticker} is an established holding with identifiable moat. Valid long-term position.`;
  } else if (conviction === "tactical") {
    delta = 0;
    reasoning = `${ticker} is a tactical position — not a 10-year compounder. Include but not overweight.`;
  } else {
    // Speculative
    if (price < 10) {
      delta = -10;
      reasoning = `${ticker} is speculative. Buffett would pass unless price is dramatically depressed.`;
    } else {
      delta = -15;
      reasoning = `${ticker} fails Buffett's wonderful business test. No durable moat, pre-revenue.`;
    }
  }

  // Step 2: Moat adjustment
  if (moat && delta > 0) {
    delta += 3;
    reasoning += ` Moat confirmed: competitive advantage durable.`;
  } else if (!moat && delta > 0) {
    delta -= 2;
    reasoning += ` No confirmed moat — competition risk.`;
  }

  // Step 3: RSI adjustment — very oversold in a core name = better entry
  if (rsi <= 30 && conviction === "core") {
    delta += 5;
    reasoning += ` RSI ${rsi.toFixed(0)} — excellent 10-year entry point in quality business.`;
  } else if (rsi <= 35 && conviction === "satellite" && moat) {
    delta += 3;
    reasoning += ` RSI ${rsi.toFixed(0)} — attractive entry in moaty business.`;
  }

  // Step 4: Confidence adjustment — low confidence in core names reduces delta less
  if (conf >= 70 && delta > 0) {
    delta += 2;
    reasoning += ` High confidence (${conf}/100) confirms signal.`;
  } else if (conf < 40 && delta > 0) {
    delta -= 1;
    reasoning += ` Low confidence (${conf}/100) — require more evidence.`;
  }

  // Clamp delta to [-20, +20]
  delta = Math.max(-20, Math.min(20, delta));

  // Buffett passes most things except speculative with poor entries
  const passes = delta >= -10 || conviction !== "speculative";

  return { delta, reasoning, passes };
}

// ── Graham Lens ───────────────────────────────────────────────────────────────

function scoreGraham(setup: TradeSetup): { delta: number; reasoning: string; passes: boolean } {
  const ticker = setup.ticker;
  const price = setup.entryPrice;
  const target = setup.targetPrice;
  const stop = setup.stopLoss;
  const conviction = getConvictionLevel(ticker);
  const dividend = isDividendPayer(ticker);
  const rsi = (setup as any).rsi ?? 50;

  // Margin of safety: how far is entry from Graham-estimated intrinsic?
  const intrinsic = getIntrinsicValueEstimate(ticker, price);
  const marginOfSafety = ((intrinsic - price) / intrinsic) * 100;

  let delta: number;
  let reasoning: string;

  // Step 1: Margin of safety drives baseline
  if (marginOfSafety >= 20) {
    delta = 15;
    reasoning = `${ticker} entry at ${marginOfSafety.toFixed(0)}% below intrinsic — strong margin of safety.`;
  } else if (marginOfSafety >= 10) {
    delta = 8;
    reasoning = `${ticker} entry at ${marginOfSafety.toFixed(0)}% below intrinsic — adequate margin of safety.`;
  } else if (marginOfSafety >= 0) {
    delta = 2;
    reasoning = `${ticker} at roughly fair value — limited margin of safety.`;
  } else {
    delta = -12;
    reasoning = `${ticker} entry above intrinsic (${marginOfSafety.toFixed(0)}% premium) — violates margin of safety.`;
  }

  // Step 2: Dividend adjustment (income = financial health confirmation)
  if (dividend) {
    delta += 4;
    reasoning += ` Dividend payer — confirms financial health.`;
  }

  // Step 3: Speculative names get heavily penalized
  if (conviction === "speculative") {
    delta -= 15;
    reasoning += ` Speculative name (ASTS) — Graham would reject entirely.`;
  } else if (conviction === "tactical") {
    delta -= 3;
    reasoning += ` Tactical position — not Graham's ideal.`;
  }

  // Step 4: RSI adjustment — very oversold with dividend = defensive buy
  if (rsi <= 30 && dividend) {
    delta += 5;
    reasoning += ` RSI ${rsi.toFixed(0)} + dividend = defensive buy zone.`;
  } else if (rsi <= 35) {
    delta += 2;
    reasoning += ` RSI ${rsi.toFixed(0)} — supports bounce thesis.`;
  }

  // Step 5: Stop loss discipline (Graham would require tight stop)
  const stopDistancePct = ((price - stop) / price) * 100;
  if (stopDistancePct > 10) {
    delta -= 3;
    reasoning += ` Stop at ${stopDistancePct.toFixed(1)}% — too wide for Graham's defensive style.`;
  }

  // Clamp
  delta = Math.max(-20, Math.min(20, delta));

  // Graham filter is stricter — requires margin of safety
  const passes = marginOfSafety >= 5 || conviction === "core";

  return { delta, reasoning, passes };
}

// ── Main Filter ─────────────────────────────────────────────────────────────

/**
 * Apply Buffett and Graham investor persona lenses to trade setups.
 * Pure algorithmic scoring — no LLM call required.
 *
 * @param setups  Raw ranked trade setups from generateTradeSetups()
 * @param _portfolioValue  Current portfolio value (for future position-sizing context)
 */
export function applyInvestorFilters(
  setups: TradeSetup[],
  _portfolioValue: number
): InvestorFilterOutput {
  if (setups.length === 0) {
    return {
      buffettLensed: [],
      grahamLensed: [],
      rejected: [],
      summary: "No setups to analyze.",
    };
  }

  const buffettLensed: TradeSetup[] = [];
  const grahamLensed: TradeSetup[] = [];
  const rejected: PersonaResult[] = [];

  for (const setup of setups) {
    const bResult = scoreBuffett(setup);
    const gResult = scoreGraham(setup);

    const passesBoth = bResult.passes && gResult.passes;

    const personaResult: PersonaResult = {
      ticker: setup.ticker,
      signal: setup.signal,
      buffettDelta: bResult.delta,
      buffettReasoning: bResult.reasoning,
      grahamDelta: gResult.delta,
      grahamReasoning: gResult.reasoning,
      passesFilter: passesBoth,
      filterFailReason: !passesBoth
        ? `Buffett: ${bResult.passes ? "pass" : "fail"} | Graham: ${gResult.passes ? "pass" : "fail"}`
        : undefined,
    };

    if (!passesBoth) {
      rejected.push(personaResult);
    }

    // Build lensed copies with adjusted scores
    const adjustedBuffettScore = Math.max(0, Math.min(100, setup.confidenceScore + bResult.delta));
    const adjustedGrahamScore = Math.max(0, Math.min(100, setup.confidenceScore + gResult.delta));

    const buffettLensedSetup: TradeSetup = {
      ...setup,
      confidenceScore: adjustedBuffettScore,
      catalyst: `[BUFFETT ${bResult.delta >= 0 ? "+" : ""}${bResult.delta}] ${bResult.reasoning}`,
    } as TradeSetup;

    const grahamLensedSetup: TradeSetup = {
      ...setup,
      confidenceScore: adjustedGrahamScore,
      catalyst: `[GRAHAM ${gResult.delta >= 0 ? "+" : ""}${gResult.delta}] ${gResult.reasoning}`,
    } as TradeSetup;

    if (bResult.passes) buffettLensed.push(buffettLensedSetup);
    if (gResult.passes) grahamLensed.push(grahamLensedSetup);
  }

  // Sort by adjusted confidence (highest first)
  buffettLensed.sort((a, b) => b.confidenceScore - a.confidenceScore);
  grahamLensed.sort((a, b) => b.confidenceScore - a.confidenceScore);

  const summary =
    `Buffett passed ${buffettLensed.length}/${setups.length} setups (delta range: ` +
    `${Math.min(...buffettLensed.map(s => s.confidenceScore - setups.find(us => us.ticker === s.ticker && us.signal === s.signal)!.confidenceScore))}` +
    ` to +${Math.max(...buffettLensed.map(s => s.confidenceScore - setups.find(us => us.ticker === s.ticker && us.signal === s.signal)!.confidenceScore))}). ` +
    `Graham passed ${grahamLensed.length}/${setups.length} setups. ` +
    `Rejected: ${rejected.length}.`;

  console.log(`[INVESTOR_FILTER] ${summary}`);

  return { buffettLensed, grahamLensed, rejected, summary };
}

// ── Formatters ────────────────────────────────────────────────────────────────

/**
 * Format filtered setups as Telegram output with investor persona lens applied.
 */
export function formatPersonaOutput(
  output: InvestorFilterOutput,
  persona: "buffett" | "graham"
): string {
  const lensName = persona === "buffett" ? "🐂 Warren Buffett Lens" : "🛡️ Ben Graham Lens";
  const lensed = persona === "buffett" ? output.buffettLensed : output.grahamLensed;

  if (lensed.length === 0) {
    return `${lensName}: No setups passed this filter.`;
  }

  const baseColor = persona === "buffett" ? "🟢" : "🔵";
  let text = `*${lensName}* — ${lensed.length} setup(s) passed:\n\n`;

  for (const setup of lensed.slice(0, 5)) {
    const confEmoji =
      setup.confidenceScore >= 75 ? "🟢" : setup.confidenceScore >= 55 ? "🟡" : "🔴";
    const action = setup.direction === "LONG" ? "BUY" : "SELL";

    // Find original score for delta display
    const baseScore = setup.confidenceScore -
      (persona === "buffett"
        ? output.rejected.find(r => r.ticker === setup.ticker)?.buffettDelta ?? 0
        : output.rejected.find(r => r.ticker === setup.ticker)?.grahamDelta ?? 0);
    const delta = setup.confidenceScore - baseScore;
    const deltaSign = delta >= 0 ? "+" : "";

    text += `${confEmoji} *${action} ${setup.ticker}* (${deltaSign}${delta} vs systematic)\n`;
    text += `   Entry $${setup.entryPrice.toFixed(2)} → Target $${setup.targetPrice.toFixed(2)}\n`;
    text += `   ${setup.catalyst}\n\n`;
  }

  return text;
}