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
  catalyst: string;
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
 * Analyze a quote and generate trade setups.
 * Returns setups that meet MIN_PROFIT_DOLLAR and MIN_RISK_REWARD criteria.
 */
export function generateTradeSetups(
  quote: MarketData,
  portfolioValue: number
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
      setups.push({
        ticker,
        direction: "LONG",
        signal: "RSI_OVERSOLD_BOUNCE",
        entryPrice: price,
        targetPrice: bounceTarget,
        stopLoss,
        riskReward,
        confidence: rsi <= 30 ? "high" : "medium",
        catalyst: `RSI at ${rsi.toFixed(0)} — historically oversold, bounce expected. Bounce target: $${bounceTarget.toFixed(2)} (${(potentialGain / price * 100).toFixed(1)}% move)`,
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
      setups.push({
        ticker,
        direction: "LONG",
        signal: "BREAKOUT_ABOVE_MA20",
        entryPrice: price,
        targetPrice: priceTarget,
        stopLoss,
        riskReward,
        confidence: volume > volumeAvg * 2 ? "high" : "medium",
        catalyst: `Breaking above MA20 on ${(volume / volumeAvg * 100).toFixed(0)}% of average volume. Target: $${priceTarget.toFixed(2)}`,
        potentialProfitDollar,
        holdDaysEstimate: Math.min(holdDays, MAX_HOLD_DAYS),
        riskDollar: maxRiskDollar,
      });
    }
  }

  // ── MA50 Reclaim (price reclaiming 50-day MA after pullback) ───────────────
  if (ma50 && Math.abs(price - ma50) / ma50 < 0.025 && Math.abs(changePercent) > 1.5) {
    if (status === "bull" || changePercent > 2) {
      const target = price * 1.04; // 4% target
      const stopLoss = price * 0.97;
      const potentialGain = target - price;
      const maxShares = Math.floor(maxRiskDollar / (price - stopLoss));
      const potentialProfitDollar = potentialGain * maxShares;
      const riskReward = potentialGain / (price - stopLoss);
      const holdDays = 5;

      if (potentialProfitDollar >= MIN_PROFIT_DOLLAR && riskReward >= MIN_RISK_REWARD) {
        setups.push({
          ticker,
          direction: "LONG",
          signal: "MOVING_AVG_RECLAIM",
          entryPrice: price,
          targetPrice: target,
          stopLoss,
          riskReward,
          confidence: "medium",
          catalyst: `Reclaiming MA50 ($${ma50.toFixed(2)}) with ${Math.abs(changePercent).toFixed(1)}% move. 4% target.`,
          potentialProfitDollar,
          holdDaysEstimate: holdDays,
          riskDollar: maxRiskDollar,
        });
      }
    }
  }

  // ── Short-Term Pullback in Uptrend ───────────────────────────────────────
  if (status === "bull" && changePercent < -1.5 && rsi > 40 && rsi < 60) {
    const support = ma20 < price ? ma20 : price * 0.98;
    const target = price * 1.03;
    const stopLoss = support * 0.98;
    const potentialGain = target - price;
    const maxShares = Math.floor(maxRiskDollar / (price - stopLoss));
    const potentialProfitDollar = potentialGain * maxShares;
    const riskReward = potentialGain / (price - stopLoss);
    const holdDays = 4;

    if (potentialProfitDollar >= MIN_PROFIT_DOLLAR && riskReward >= MIN_RISK_REWARD) {
      setups.push({
        ticker,
        direction: "LONG",
        signal: "SHORT_TERM_PULLBACK",
        entryPrice: price,
        targetPrice: target,
        stopLoss,
        riskReward,
        confidence: "medium",
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
      // Primary sort: risk/reward (higher is better)
      const d = b.riskReward - a.riskReward;
      if (Math.abs(d) > 0.5) return d;
      // Secondary: confidence
      const conf = { high: 0, medium: 1, low: 2 };
      const cd = conf[a.confidence] - conf[b.confidence];
      if (cd !== 0) return cd;
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
 * Format ranked trade setups for Telegram brief.
 */
export function formatTradeSetups(setups: TradeSetup[]): string {
  if (setups.length === 0) {
    return "🎯 *TRADE SETUPS*\nNo setups meet criteria today ($1,000+ profit, 2:1+ R/R, ≤14 days).";
  }

  let output = `🎯 *TRADE SETUPS* (${setups.length} flagged)\n`;
  output += `_Ranked by risk/reward. Min profit $1K, max 14-day hold._\n\n`;

  for (const setup of setups) {
    const confEmoji = setup.confidence === "high" ? "🟢" : setup.confidence === "medium" ? "🟡" : "🟡";
    const dirEmoji = setup.direction === "LONG" ? "📈" : "📉";
    output += `${confEmoji} ${dirEmoji} ${setup.ticker} — ${setup.signal.replace(/_/g, " ")}\n`;
    output += `   Entry: $${setup.entryPrice.toFixed(2)} → Target: $${setup.targetPrice.toFixed(2)} | Stop: $${setup.stopLoss.toFixed(2)}\n`;
    output += `   R/R: ${setup.riskReward.toFixed(1)}:1 | Profit: $${setup.potentialProfitDollar.toFixed(0)} | Hold: ${setup.holdDaysEstimate}d\n`;
    output += `   ${setup.catalyst}\n\n`;
  }

  return output;
}