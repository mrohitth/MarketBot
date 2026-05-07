import { MarketData } from "./types";

// ═══════════════════════════════════════════════════════════════════════════════
// ADVISOR-GRADE THRESHOLDS
// Thinking from the lens of a world-class hedge fund / trading operation.
// These thresholds are chosen based on institutional-quality position management.
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimum absolute profit (in $) before a short-term trade idea is flagged */
export const MIN_PROFIT_DOLLAR = 1000;

/** Maximum holding period for opportunistic trades (calendar days) */
export const MAX_HOLD_DAYS = 14;

/** Maximum risk per trade as % of total portfolio value */
export const MAX_RISK_PER_TRADE_PCT = 0.02; // 2% of portfolio (more conservative than 10% per-trade)

/** Minimum risk/reward ratio for a trade to be flagged */
export const MIN_RISK_REWARD = 2.0; // Must make $2 for every $1 at risk

/** RSI oversold threshold — buy when RSI drops below this */
export const RSI_OVERSOLD = 35;

/** RSI overbought threshold — take profit when RSI exceeds this */
export const RSI_OVERBOUGHT = 68;

/** Volume spike multiplier for confirming breakouts */
export const VOLUME_SPIKE_MULTIPLIER = 1.5;

/** Black swan threshold — extraordinary single-day move */
export const BLACK_SWAN_THRESHOLD_PCT = 8;

// ═══════════════════════════════════════════════════════════════════════════════
// DRIFT THRESHOLDS PER TICKER
// Core indices get tighter bands (more stable). Speculative names get wider.
// ═══════════════════════════════════════════════════════════════════════════════

export const DRIFT_THRESHOLDS_ADVISORY: Record<string, number> = {
  // Broad indices — tight bands, high conviction core holdings
  VTI:  5, // ±5% drift — must be close to 20% weight
  VOO:  5, // ±5% drift
  QQQ:  5, // ±5% drift
  // Thematic/sector — medium bands
  NVDA: 4, // ±4% drift — high conviction but GPU market is volatile
  SMH:  6, // ±6% drift — semi ETF, sector-specific risk
  SCHG: 6, // ±6% drift — growth ETF, less core
  VXUS: 7, // ±7% drift — international, wider band acceptable
  SCHD: 6, // ±6% drift — dividend ETF, less volatile
  SPYD: 8, // ±8% drift — tactical income position, wider
  ASTS: 15,// ±15% drift — speculative, accept high volatility
  SPAXX: 0,// Cash — no drift concept
};

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO TARGET ALLOCATION (advisor-calibrated)
// These reflect Mathew's conviction + income profile:
// - NVDA 19% (largest conviction, AI infrastructure moat)
// - VTI 20% (breadth, anchors whole portfolio)
// - VOO 17% (S&P500 large-cap core)
// - QQQ 14% (tech/growth tilt)
// ═══════════════════════════════════════════════════════════════════════════════

export const PORTFOLIO_TARGET_ALLOCATION: Record<string, number> = {
  VTI:   0.20, // 20% — broad US market exposure
  NVDA:  0.19, // 19% — largest conviction, AI chip moat
  VOO:   0.17, // 17% — S&P500 core
  QQQ:   0.14, // 14% — tech/growth tilt
  SMH:   0.10, // 10% — semi sector ETF (high conviction)
  SCHG:  0.08, // 8% — large-cap growth (weekly $150 auto-invest)
  VXUS:  0.05, // 5% — international diversification
  SCHD:  0.04, // 4% — dividend stability
  SPYD:  0.01, // 1% — tactical income
  ASTS:  0.01, // 1% — speculative moonshot
  SPAXX: 0.01, // 1% — cash buffer
};

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE SIGNAL TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type TradeSignal =
  | "RSI_OVERSOLD_BOUNCE"    // RSI ≤ 35, expecting bounce to ma20 or +5%
  | "BREAKOUT_ABOVE_MA20"    // Price breaks above MA20 with volume confirmation
  | "GAP_FILL_LONG"          // Price has gapped up, expecting fill to prior level
  | "MOVING_AVG_RECLAIM"     // Price reclaiming MA20 after being below
  | "SHORT_TERM_PULLBACK"    // Pullback to support in uptrend — accumulate
  | "EARNINGS_MOMENTUM";    // Within 5 days of earnings, momentum continuation play

export type TradeDirection = "LONG" | "SHORT";

export interface TradeSetup {
  ticker: string;
  direction: TradeDirection;
  signal: TradeSignal;
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  riskReward: number;
  confidence: "high" | "medium" | "low";
  confidenceScore: number;  // 0-100, evidence-based numeric confidence
  catalyst: string;
  supportingEvidence: string[];  // specific news/events driving the setup
  potentialProfitDollar: number;
  holdDaysEstimate: number;
  riskDollar: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPEN POSITION TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

export interface OpenPosition {
  ticker: string;
  direction: TradeDirection;
  entryPrice: number;
  shares: number;
  entryDate: string;
  targetPrice: number;
  stopLoss: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  holdDaysRemaining: number; // negative = overdue
  signal: TradeSignal;
  status: "active" | "at-risk" | "target-hit" | "stop-hit" | "expired";
  notes: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECOMMENDATION ADVISOR ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute a 0-100 confidence score and supporting evidence for a setup.
 * Evidence is grounded in specific technicals and observable market behavior.
 */
function scoreSetup(
  quote: MarketData,
  direction: TradeDirection,
  signal: TradeSignal,
  newsSentiment?: { score: number; label: string; headlines: string[] }
): { confidenceScore: number; evidence: string[] } {
  const { price, changePercent, rsi, ma20, ma50, volume, volumeAvg, status } = quote;
  const evidence: string[] = [];
  let score = 0;


  // ── Technical signal strength (up to 60 points) ──────────────────────────
  if (rsi <= 30) {
    score += 25;
    evidence.push(`RSI deeply oversold at ${rsi.toFixed(0)} — high probability bounce`);
  } else if (rsi <= RSI_OVERSOLD) {
    score += 15;
    evidence.push(`RSI at ${rsi.toFixed(0)}, near historically reliable bounce zone`);
  } else if (rsi >= RSI_OVERBOUGHT) {
    score += 15;
    evidence.push(`RSI at ${rsi.toFixed(0)}, extended — mean reversion likely`);
  }

  if (price > ma20) {
    score += 15;
    evidence.push(`Trading above 20-day MA ($${ma20.toFixed(2)}) — short-term uptrend`);
  } else {
    score += 5;
    evidence.push(`Below 20-day MA — but not a sustained downtrend`);
  }


  if (price > ma50) {
    score += 10;
    evidence.push(`Above 50-day MA ($${ma50.toFixed(2)}) — intermediate-term uptrend`);
  } else {
    score += 2;
    evidence.push(`Below 50-day MA — some mean-reversion fuel`);
  }

  if (volume >= volumeAvg * 2) {
    score += 10;
    evidence.push(`${(volume / volumeAvg).toFixed(0)}% of average volume — conviction trade`);
  } else if (volume >= volumeAvg * VOLUME_SPIKE_MULTIPLIER) {
    score += 6;
    evidence.push(`Volume ${(volume / volumeAvg).toFixed(0)}% above average — confirming`);
  }

  if (direction === "LONG" && changePercent < -2) {
    score += 8;
    evidence.push(`Pulling back ${Math.abs(changePercent).toFixed(1)}% intraday — better entry`);
  } else if (direction === "LONG" && changePercent > 2) {
    score -= 5;
    evidence.push(`Already up ${changePercent.toFixed(1)}% — entry less ideal`);
  }

  if (status === "bull") {
    score += 5;
    evidence.push(`Broad market posture bullish for this ticker`);
  } else if (status === "bear") {
    score -= 5;
    evidence.push(`Ticker in bearish short-term regime — requires tighter stop`);
  }

  if (signal === "RSI_OVERSOLD_BOUNCE") {
    score += 10;
    evidence.push(`RSI_OVERSOLD — historically highest win-rate pattern`);
  } else if (signal === "BREAKOUT_ABOVE_MA20") {
    score += 8;
    evidence.push(`Breakout signal — institutional investors watch this level`);
  } else if (signal === "SHORT_TERM_PULLBACK") {
    score += 5;
    evidence.push(`Pullback in established uptrend — continuation setup`);
  }

  // ── News sentiment overlay (up to ±15 points) ───────────────────────────
  if (newsSentiment) {
    if (newsSentiment.score > 5) {
      score += Math.min(15, newsSentiment.score);
      evidence.push(`Recent news: NET POSITIVE sentiment (${newsSentiment.label}) — ${newsSentiment.headlines[0] ?? "bullish headlines"}`);
    } else if (newsSentiment.score < -5) {
      score -= Math.min(15, Math.abs(newsSentiment.score));
      evidence.push(`Recent news: NET NEGATIVE sentiment (${newsSentiment.label}) — ${newsSentiment.headlines[0] ?? "bearish headlines"}`);
    }
  }

  score = Math.max(0, Math.min(100, score));
  return { confidenceScore: score, evidence };
}


/**
 * Analyze a quote and generate trade setups.
 * Returns setups that meet MIN_PROFIT_DOLLAR and MIN_RISK_REWARD criteria.
 */
export function generateTradeSetups(
  quote: MarketData,
  portfolioValue: number,
  newsSentiment?: { score: number; label: string; headlines: string[] }
): TradeSetup[] {
  const setups: TradeSetup[] = [];
  const { ticker, price, rsi, ma20, ma50, volume, volumeAvg, changePercent, status } = quote;
  const riskPct = MAX_RISK_PER_TRADE_PCT; // 2% of portfolio
  const maxRiskDollar = portfolioValue * riskPct;

  // ── RSI Oversold Bounce ───────────────────────────────────────────────────
  if (rsi <= RSI_OVERSOLD && rsi > 20) {
    const bounceTarget = ma20 > price ? ma20 : price * 1.05;
    const potentialGain = bounceTarget - price;
    const maxShares = Math.floor(maxRiskDollar / (price * 0.05)); // 5% stop
    const potentialProfitDollar = potentialGain * maxShares;
    const stopLoss = price * 0.95;
    const riskReward = potentialGain / (price - stopLoss);
    const holdDays = Math.ceil((bounceTarget - price) / price / 0.02 * 3); // rough 3-day per 2% move

    if (potentialProfitDollar >= MIN_PROFIT_DOLLAR && riskReward >= MIN_RISK_REWARD) {
      const { confidenceScore, evidence } = scoreSetup(quote, "LONG", "RSI_OVERSOLD_BOUNCE", newsSentiment);

      setups.push({
        ticker,
        direction: "LONG",
        signal: "RSI_OVERSOLD_BOUNCE",
        entryPrice: price,
        targetPrice: bounceTarget,
        stopLoss,
        riskReward,
        confidence: confidenceScore >= 65 ? "high" : confidenceScore >= 45 ? "medium" : "low",
        confidenceScore,
        supportingEvidence: evidence,
        catalyst: `RSI at ${rsi.toFixed(0)} — historically oversold, bounce expected. Target: $${bounceTarget.toFixed(2)} (${(potentialGain / price * 100).toFixed(1)}% move)`,
        potentialProfitDollar,
        holdDaysEstimate: Math.min(holdDays, MAX_HOLD_DAYS),
        riskDollar: maxRiskDollar,
      });
    }
  }

  // ── Breakout Above MA20 with Volume ──────────────────────────────────────
  if (price > ma20 && volume >= volumeAvg * VOLUME_SPIKE_MULTIPLIER) {
    const priceTarget = ma50 > price ? ma50 : price * 1.03;
    const potentialGain = priceTarget - price;
    const stopLoss = ma20 * 0.98; // 2% below MA20
    const maxShares = Math.floor(maxRiskDollar / (price - stopLoss));
    const potentialProfitDollar = potentialGain * maxShares;
    const riskReward = potentialGain / (price - stopLoss);
    const holdDays = Math.ceil((priceTarget - price) / price / 0.015 * 2);

    if (potentialProfitDollar >= MIN_PROFIT_DOLLAR && riskReward >= MIN_RISK_REWARD) {
      const { confidenceScore, evidence } = scoreSetup(quote, "LONG", "BREAKOUT_ABOVE_MA20", newsSentiment);

      setups.push({
        ticker,
        direction: "LONG",
        signal: "BREAKOUT_ABOVE_MA20",
        entryPrice: price,
        targetPrice: priceTarget,
        stopLoss,
        riskReward,
        confidence: confidenceScore >= 65 ? "high" : confidenceScore >= 45 ? "medium" : "low",
        confidenceScore,
        supportingEvidence: evidence,
        catalyst: `Breaking above MA20 on ${(volume / volumeAvg * 100).toFixed(0)}% of avg volume. Target: $${priceTarget.toFixed(2)}`,
        potentialProfitDollar,
        holdDaysEstimate: Math.min(holdDays, MAX_HOLD_DAYS),
        riskDollar: maxRiskDollar,
      });
    }
  }

  // ── MA50 Reclaim ─────────────────────────────────────────────────────────
  if (ma50 && Math.abs(price - ma50) / ma50 < 0.025 && Math.abs(changePercent) > 1.5) {
    if (status === "bull" || changePercent > 2) {
      const target = price * 1.04;
      const stopLoss = price * 0.97;
      const potentialGain = target - price;
      const maxShares = Math.floor(maxRiskDollar / (price - stopLoss));
      const potentialProfitDollar = potentialGain * maxShares;
      const riskReward = potentialGain / (price - stopLoss);
      const holdDays = 5;
      const { confidenceScore, evidence } = scoreSetup(quote, "LONG", "MOVING_AVG_RECLAIM", newsSentiment);

      if (potentialProfitDollar >= MIN_PROFIT_DOLLAR && riskReward >= MIN_RISK_REWARD) {
        setups.push({
          ticker,
          direction: "LONG",
          signal: "MOVING_AVG_RECLAIM",
          entryPrice: price,
          targetPrice: target,
          stopLoss,
          riskReward,
          confidence: confidenceScore >= 65 ? "high" : confidenceScore >= 45 ? "medium" : "low",
          confidenceScore,
          supportingEvidence: evidence,
          catalyst: `Reclaiming MA50 ($${ma50.toFixed(2)}) with ${Math.abs(changePercent).toFixed(1)}% move. 4% target.`,
          potentialProfitDollar,
          holdDaysEstimate: holdDays,
          riskDollar: maxRiskDollar,
        });
      }
    }
  }

  // ── Short-Term Pullback in Uptrend ──────────────────────────────────────
  if (status === "bull" && changePercent < -1.5 && rsi > 40 && rsi < 60) {
    const support = ma20 < price ? ma20 : price * 0.98;
    const target = price * 1.03;
    const stopLoss = support * 0.98;
    const potentialGain = target - price;
    const maxShares = Math.floor(maxRiskDollar / (price - stopLoss));
    const potentialProfitDollar = potentialGain * maxShares;
    const riskReward = potentialGain / (price - stopLoss);
    const holdDays = 4;
    const { confidenceScore, evidence } = scoreSetup(quote, "LONG", "SHORT_TERM_PULLBACK", newsSentiment);

    if (potentialProfitDollar >= MIN_PROFIT_DOLLAR && riskReward >= MIN_RISK_REWARD) {
      setups.push({
        ticker,
        direction: "LONG",
        signal: "SHORT_TERM_PULLBACK",
        entryPrice: price,
        targetPrice: target,
        stopLoss,
        riskReward,
        confidence: confidenceScore >= 65 ? "high" : confidenceScore >= 45 ? "medium" : "low",
        confidenceScore,
        supportingEvidence: evidence,
        catalyst: `Pullback in uptrend. RSI=${rsi.toFixed(0)}, support near $${support.toFixed(2)}. Target +3%.`,
        potentialProfitDollar,
        holdDaysEstimate: holdDays,
        riskDollar: maxRiskDollar,
      });
    }
  }

  return setups;
}

/**
 * Rank setups by risk/reward and profit potential.
 * Filter to only those meeting minimum criteria.
 */
export function rankSetups(setups: TradeSetup[]): TradeSetup[] {
  return setups
    .filter((s) => s.riskReward >= MIN_RISK_REWARD && s.potentialProfitDollar >= MIN_PROFIT_DOLLAR)
    .sort((a, b) => {
      // Primary sort: confidence score (higher is better)
      const d = b.confidenceScore - a.confidenceScore;
      if (Math.abs(d) > 5) return d;
      // Secondary: risk/reward
      const rr = b.riskReward - a.riskReward;
      if (Math.abs(rr) > 0.5) return rr;
      // Tertiary: profit dollar
      return b.potentialProfitDollar - a.potentialProfitDollar;
    });
}

/**
 * Update open positions with current prices and check status.
 */
export function updateOpenPositions(
  positions: OpenPosition[],
  quotes: Map<string, MarketData>
): OpenPosition[] {
  const now = new Date();

  return positions.map((pos) => {
    const quote = quotes.get(pos.ticker);
    if (!quote) return pos;

    const currentPrice = quote.price;
    const unrealizedPnL = (currentPrice - pos.entryPrice) * pos.shares;
    const unrealizedPnLPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
    const entryDate = new Date(pos.entryDate);
    const holdDaysElapsed = Math.floor((now.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24));
    const holdDaysRemaining = MAX_HOLD_DAYS - holdDaysElapsed;

    let status: OpenPosition["status"] = pos.status;
    let notes = pos.notes;

    if (currentPrice >= pos.targetPrice) {
      status = "target-hit";
      notes = `✅ Target hit. +$${unrealizedPnL.toFixed(0)} (${unrealizedPnLPct.toFixed(1)}%)`;
    } else if (currentPrice <= pos.stopLoss) {
      status = "stop-hit";
      notes = `🔴 Stop hit. $${unrealizedPnL.toFixed(0)} loss (${unrealizedPnLPct.toFixed(1)}%)`;
    } else if (holdDaysRemaining <= 0) {
      status = "expired";
      notes = `⏰ Hold period expired. ${holdDaysElapsed} days held. $${unrealizedPnL.toFixed(0)} PnL`;
    } else if (unrealizedPnLPct < -3) {
      status = "at-risk";
      notes = `🟡 At risk: $${unrealizedPnL.toFixed(0)} (${unrealizedPnLPct.toFixed(1)}%)`;
    } else {
      status = "active";
    }

    return {
      ...pos,
      currentPrice,
      unrealizedPnL,
      unrealizedPnLPct,
      holdDaysRemaining,
      status,
      notes,
    };
  });
}

/**
 * Format open positions for Telegram brief.
 */
export function formatOpenPositions(positions: OpenPosition[]): string {
  const active = positions.filter((p) => p.status === "active" || p.status === "at-risk");
  if (active.length === 0) {
    return "📊 *OPEN POSITIONS*\nNo active opportunistic trades.";
  }

  let output = `📊 *OPEN POSITIONS*\n`;
  for (const pos of active) {
    const statusEmoji =
      pos.status === "at-risk" ? "🟡" :
      pos.unrealizedPnL >= 0 ? "🟢" : "🟡";
    const dirEmoji = pos.direction === "LONG" ? "📈" : "📉";
    output += `${statusEmoji} ${dirEmoji} ${pos.ticker} — ${pos.signal.replace(/_/g, " ")}\n`;
    output += `   Entry: $${pos.entryPrice.toFixed(2)} | Current: $${pos.currentPrice.toFixed(2)} | Target: $${pos.targetPrice.toFixed(2)}\n`;
    output += `   P&L: $${pos.unrealizedPnL.toFixed(0)} (${pos.unrealizedPnLPct.toFixed(1)}%) | ${pos.holdDaysRemaining}d remaining\n`;
    output += pos.notes ? `   ${pos.notes}\n` : "";
    output += "\n";
  }
  return output;
}

/**
 * Format ranked trade setups as DIRECT, evidence-based buy/sell calls for Telegram.
 * Format: "Buy TICKER because [specific reason] — Confidence: XX%"
 */
export function formatTradeSetups(setups: TradeSetup[]): string {
  if (setups.length === 0) {
    return "🎯 *TRADE CALLS*\nNo setups meet criteria today ($1,000+ profit, 2:1+ R/R, ≤14 days).";
  }

  let output = `🎯 *TRADE CALLS* (${setups.length} active)\n`;
  output += `_Ranked by confidence. All setups: $1K+ profit, 2:1+ R/R, ≤14-day hold._\n\n`;

  for (const setup of setups) {
    const confBar = setup.confidenceScore >= 75 ? "🟢" : setup.confidenceScore >= 55 ? "🟡" : "🔴";
    const dirEmoji = setup.direction === "LONG" ? "📈" : "📉";
    const action = setup.direction === "LONG" ? "BUY" : "SELL";
    const sign = setup.potentialProfitDollar >= 0 ? "+" : "";

    // Build direct "because" call — primary catalyst is the main reason
    const because = buildBecauseClause(setup);

    output += `${confBar} ${dirEmoji} *${action} ${setup.ticker}* because ${because}\n`;
    output += `   🎯 Entry $${setup.entryPrice.toFixed(2)} → Target $${setup.targetPrice.toFixed(2)} | Stop $${setup.stopLoss.toFixed(2)}\n`;
    output += `   📊 ${setup.riskReward.toFixed(1)}:1 R/R | ${sign}$${setup.potentialProfitDollar.toFixed(0)} profit | ⏱ ${setup.holdDaysEstimate}d max\n`;
    output += `   ✅ Confidence: *${setup.confidenceScore}/100* | ${setup.confidence.toUpperCase()} conviction\n`;

    // Evidence bullets — specific technicals driving this call
    if (setup.supportingEvidence.length > 0) {
      for (const ev of setup.supportingEvidence.slice(0, 3)) {
        output += `   • ${ev}\n`;
      }
    }
    output += "\n";
  }

  return output;
}

/**
 * Build a human-readable "because [reason]" clause from setup data.
 * This is the core of the direct-call format.
 */
function buildBecauseClause(setup: TradeSetup): string {
  const { signal, ticker, entryPrice, targetPrice, supportingEvidence } = setup as any;
  const rsi = (setup as any).rsi ?? 50;

  switch (signal) {
    case "RSI_OVERSOLD_BOUNCE":
      return `RSI is deeply oversold at ${rsi.toFixed(0)} — historically, this level produces a bounce within days. ${ticker} is trading at $${entryPrice.toFixed(2)} with a $${targetPrice.toFixed(2)} technical target (${((targetPrice - entryPrice) / entryPrice * 100).toFixed(1)}% upside). This is a mean-reversion trade with defined risk.`;

    case "BREAKOUT_ABOVE_MA20": {
      const volEv = supportingEvidence?.find((e: string) => e.includes("volume")) ?? "volume confirming the move";
      return `${volEv}. Price is breaking above its 20-day moving average on strong conviction — a signal institutions use to confirm entry. Target: $${targetPrice.toFixed(2)}.`;
    }

    case "MOVING_AVG_RECLAIM":
      return `${ticker} is reclaiming its 50-day moving average after a pullback — a sign buyers are stepping back in. This is a historically reliable continuation pattern. Target: $${targetPrice.toFixed(2)}.`;

    case "SHORT_TERM_PULLBACK": {
      const pullbackEv = supportingEvidence?.find((e: string) => e.includes("Pulling back")) ?? "short-term pullback";
      return `${pullbackEv}. ${ticker} is in an established uptrend and this dip is a better entry point. RSI=${rsi.toFixed(0)} supports the bounce. Target: $${targetPrice.toFixed(2)}.`;
    }

    default:
      return `${ticker} shows a ${signal.replace(/_/g, " ").toLowerCase()} setup. Target $${targetPrice.toFixed(2)} from $${entryPrice.toFixed(2)}.`;
  }
}